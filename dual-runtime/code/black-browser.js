(() => {
  if (window.__aisProxyBridgeStarted) return;
  window.__aisProxyBridgeStarted = true;

const Logger = {
  enabled: true,
  output(...messages) {
    if (!this.enabled) return;
    const timestamp =
      new Date().toLocaleTimeString("zh-CN", { hour12: false }) +
      "." +
      new Date().getMilliseconds().toString().padStart(3, "0");
    console.log(`[ProxyClient] ${timestamp}`, ...messages);
    const logElement = document.createElement("div");
    logElement.textContent = `[${timestamp}] ${messages.join(" ")}`;
    if (document.body) document.body.appendChild(logElement);
  },
};

class ConnectionManager {
  // =================================================================
  // ===                 *** EDIT THIS LINE   *** ===
  constructor(endpoint = "ws://127.0.0.1:9998") {
    // =================================================================
    this.eventTarget = new EventTarget();
    this.endpoint = endpoint;
    this.socket = null;
    this.isConnected = false;
    this.reconnectDelay = 5000;
    this.reconnectAttempts = 0;
    this.operationSockets = new Map();
  }

  addEventListener(...args) {
    return this.eventTarget.addEventListener(...args);
  }

  dispatchEvent(...args) {
    return this.eventTarget.dispatchEvent(...args);
  }

  async establish() {
    if (this.isConnected) return Promise.resolve();
    Logger.output("Connecting to server:", this.endpoint);
    return new Promise((resolve, reject) => {
      try {
        this.socket = new WebSocket(this.endpoint);
        this.socket.addEventListener("open", () => {
          this.isConnected = true;
          this.reconnectAttempts = 0;
          Logger.output("✅ Connected!");
          this.dispatchEvent(new CustomEvent("connected"));
          resolve();
        });
        this.socket.addEventListener("close", () => {
          this.isConnected = false;
          Logger.output("❌ Connection closed; reconnecting...");
          this.dispatchEvent(new CustomEvent("disconnected"));
          this._scheduleReconnect();
        });
        this.socket.addEventListener("error", (error) => {
          Logger.output(" WebSocket connection error:", error);
          this.dispatchEvent(new CustomEvent("error", { detail: error }));
          if (!this.isConnected) reject(error);
        });
        this.socket.addEventListener("message", (event) => {
          this.dispatchEvent(
            new CustomEvent("message", { detail: event.data })
          );
        });
      } catch (e) {
        Logger.output(
          "WebSocket initialization failed. Check the address or browser security policy.",
          e.message
        );
        reject(e);
      }
    });
  }

  transmit(data) {
    if (data.request_id && this.operationSockets.has(data.request_id) &&
        this.operationSockets.get(data.request_id) !== this.socket) return false;
    if (!this.isConnected || !this.socket || this.socket.readyState !== WebSocket.OPEN) {
      Logger.output("Cannot send data: connection is not established");
      return false;
    }
    this.socket.send(JSON.stringify(data));
    return true;
  }

  _scheduleReconnect() {
    this.reconnectAttempts++;
    setTimeout(() => {
      Logger.output(`Starting reconnect attempt ${this.reconnectAttempts}...`);
      this.establish().catch(() => {});
    }, this.reconnectDelay);
  }
}

class RequestProcessor {
  constructor() {
    this.activeOperations = new Map();
    this.cancelledOperations = new Set();
    this.targetDomain = "generativelanguage.googleapis.com";
    this.maxRetries = 3; // Maximum 3 attempts
    this.retryDelay = 2000; // Wait 2 seconds before each retry
  }

  execute(requestSpec, operationId) {
    const IDLE_TIMEOUT_DURATION = 600000;
    const abortController = new AbortController();
    this.activeOperations.set(operationId, abortController);

    let timeoutId = null;

    // One deadline covers fetch and body consumption; cleanup clears it.

    const cancelTimeout = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        Logger.output("Received a data chunk; timeout cleared.");
      }
    };

    const attemptPromise = new Promise(async (resolve, reject) => {
      for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
        try {
          if (abortController.signal.aborted) {
            throw new DOMException("Request cancelled", "AbortError");
          }
          Logger.output(
            `Executing request (attempt ${attempt}/${this.maxRetries}):`,
            requestSpec.method,
            requestSpec.path
          );

          const requestUrl = this._constructUrl(requestSpec);
          const requestConfig = this._buildRequestConfig(
            requestSpec,
            abortController.signal
          );

          const response = await fetch(requestUrl, requestConfig);

          if (!response.ok) {
            const errorBody = await response.text();
            const error = new Error(
              `Google API returned an error: ${response.status} ${response.statusText} ${errorBody}`
            );
            error.status = response.status;
            error.retryAfter = response.headers.get("retry-after");
            throw error;
          }

          resolve(response);
          return;
        } catch (error) {
          if (error.name === "AbortError") {
            reject(error);
            return;
          }
          const isNetworkError = error.message.includes("Failed to fetch");
          const isRetryableServerError =
            error.status && [500, 502, 503, 504].includes(error.status);
          if (
            isRetryableServerError &&
            !abortController.signal.aborted &&
            attempt < this.maxRetries
          ) {
            Logger.output(
              `❌ Request attempt #${attempt} failed: ${error.message.substring(0, 200)}`
            );
            Logger.output(`Retrying in ${this.retryDelay / 1000} seconds...`);
            await new Promise((r) => setTimeout(r, this.retryDelay));
            continue;
          } else {
            reject(error);
            return;
          }
        }
      }
    });

    // Abort on deadline, but await the actual fetch settlement before completion.
    // A Promise.race timeout is not evidence that browser work has stopped.
    timeoutId = setTimeout(() => abortController.abort(), IDLE_TIMEOUT_DURATION);
    const responsePromise = attemptPromise.catch((error) => {
      cancelTimeout();
      throw error;
    });

    return { responsePromise, cancelTimeout };
  }

  cancelAllOperations() {
    this.activeOperations.forEach((controller, id) => controller.abort());
    // Keep operation records until their fetch/stream actually settles.
  }

  _getGenerationPath(requestSpec) {
    let pathSegment = requestSpec.path.startsWith("/")
      ? requestSpec.path.substring(1)
      : requestSpec.path;

    if (requestSpec.streaming_mode === "fake" && pathSegment.includes(":streamGenerateContent")) {
      pathSegment = pathSegment.replace(":streamGenerateContent", ":generateContent");
      Logger.output(`API path changed to: ${pathSegment}`);
    }

    return pathSegment;
  }

  _usesMakerSuiteBridge(requestSpec) {
    return requestSpec.method === "POST" &&
      /^v1beta\/models\/[^:/?]+:(?:generateContent|streamGenerateContent)$/.test(
        this._getGenerationPath(requestSpec)
      );
  }

  _constructUrl(requestSpec) {
    if (this._usesMakerSuiteBridge(requestSpec)) {
      const streamed = this._getGenerationPath(requestSpec).includes(":streamGenerateContent");
      const rpcMethod = streamed ? "ProxyStreamedCall" : "ProxyUnaryCall";
      return `https://alkalimakersuite-pa.clients6.google.com/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/${rpcMethod}`;
    }

    const pathSegment = this._getGenerationPath(requestSpec);
    const queryParams = new URLSearchParams(requestSpec.query_params);
    if (requestSpec.streaming_mode === "fake" && queryParams.get("alt") === "sse") {
      queryParams.delete("alt");
    }
    const queryString = queryParams.toString();
    return `https://${this.targetDomain}/${pathSegment}${queryString ? "?" + queryString : ""}`;
  }

  _generateRandomString(length) {
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    let result = "";
    for (let i = 0; i < length; i++)
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    return result;
  }

  _buildRequestConfig(requestSpec, signal) {
    const config = {
      method: requestSpec.method,
      headers: this._sanitizeHeaders(requestSpec.headers),
      signal,
    };

    if (
      ["POST", "PUT", "PATCH"].includes(requestSpec.method) &&
      requestSpec.body
    ) {
      try {
        let bodyObj = JSON.parse(requestSpec.body);

        const useMakerSuiteBridge = this._usesMakerSuiteBridge(requestSpec);
        // The internal marker is accepted by the page's MakerSuite interceptor,
        // which removes it before calling Google. Public API requests must not send it.
        if (!useMakerSuiteBridge) delete bodyObj.__aisRid;

        // --- Module 1: smart filtering (preserved) ---
        const isImageModel =
          requestSpec.path.includes("-image-") ||
          requestSpec.path.includes("imagen");

        if (isImageModel) {
          const incompatibleKeys = ["tool_config", "toolChoice", "tools"];
          incompatibleKeys.forEach((key) => {
            if (bodyObj.hasOwnProperty(key)) delete bodyObj[key];
          });
          if (bodyObj.generationConfig?.thinkingConfig) {
            delete bodyObj.generationConfig.thinkingConfig;
          }
        }

        config.body = useMakerSuiteBridge
          ? JSON.stringify([
              `models/${this._getGenerationPath(requestSpec).match(/^v1beta\/models\/([^:/?]+):/)[1]}:${this._getGenerationPath(requestSpec).includes(":streamGenerateContent") ? "stream" : ""}generateContent`,
              JSON.stringify(bodyObj),
            ])
          : JSON.stringify(bodyObj);
      } catch (e) {
        Logger.output("Error processing request body:", e.message);
        config.body = requestSpec.body;
      }
    }

    return config;
  }

  _sanitizeHeaders(headers) {
    const sanitized = { ...headers };
    [
      "host",
      "connection",
      "content-length",
      "origin",
      "referer",
      "user-agent",
      "sec-fetch-mode",
      "sec-fetch-site",
      "sec-fetch-dest",
    ].forEach((h) => delete sanitized[h]);
    return sanitized;
  }
  cancelOperation(operationId) {
    this.cancelledOperations.add(operationId); // Core: add ID to cancellation set
    const controller = this.activeOperations.get(operationId);
    if (controller) {
      Logger.output(`Received cancellation command; aborting operation #${operationId}...`);
      controller.abort();
    }
  }
} // <--- Critical: ensure this brace exists

class ProxySystem {
  constructor(websocketEndpoint) {
    this.eventTarget = new EventTarget();
    this.connectionManager = new ConnectionManager(websocketEndpoint);
    this.requestProcessor = new RequestProcessor();
    this.connectionManager.addEventListener("message", (e) =>
      this._handleIncomingMessage(e.detail)
    );
    this.connectionManager.addEventListener("disconnected", () =>
      this.requestProcessor.cancelAllOperations()
    );
  }

  dispatchEvent(...args) {
    return this.eventTarget.dispatchEvent(...args);
  }

  async initialize() {
    Logger.output("Initializing system...");
    while (true) {
      try {
        await this.connectionManager.establish();
        break;
      } catch (error) {
        Logger.output("Failed to connect to server; retrying in 1 second...");
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    Logger.output("System initialized; waiting for server commands...");
    this.dispatchEvent(new CustomEvent("ready"));
  }


  async _handleIncomingMessage(messageData) {
    let requestSpec = {};
    try {
      requestSpec = JSON.parse(messageData);

      // --- Core change: dispatch by event_type ---
      switch (requestSpec.event_type) {
        case "worker_challenge":
          if (requestSpec.protocol === 1 &&
              this.requestProcessor.activeOperations.size === 0 &&
              typeof requestSpec.challenge === "string" &&
              requestSpec.challenge.length <= 256) {
            this.connectionManager.transmit({
              event_type: "worker_hello", protocol: 1,
              operation_done: true, challenge: requestSpec.challenge
            });
          }
          return;
        case "cancel_request":
          // For a cancellation command, call the cancellation method
          this.requestProcessor.cancelOperation(requestSpec.request_id);
          break;
        default:
          // By default, treat it as a proxy request
          // [Final optimization] Show only the path; its mode is already clear
          Logger.output(`Received request: ${requestSpec.method} ${requestSpec.path}`);

          await this._processProxyRequest(requestSpec);
          break;
      }
    } catch (error) {
      Logger.output("Message handling error:", error.message);
      // Send an error response only when proxy request handling fails
      if (
        requestSpec.request_id &&
        requestSpec.event_type !== "cancel_request"
      ) {
        this._sendErrorResponse(error, requestSpec.request_id);
      }
    }
  }

  // 在 v3.4-black-browser.js 中
  // [Final approach - Canvas extraction] Replace the entire _processProxyRequest function
  async _processProxyRequest(requestSpec) {
    const operationId = requestSpec.request_id;
    const mode = requestSpec.streaming_mode || "fake";
    Logger.output(`Browser received request`);
    const operationSocket = this.connectionManager.socket;
    let cancelTimeout = () => {};
    let reader = null;
    let settled = false;
    if (typeof operationId !== "string" || !operationId ||
        this.requestProcessor.activeOperations.size >= 2) {
      this._sendErrorResponse({ status: 409, message: "Invalid request or worker busy" }, operationId);
      return;
    }
    this.connectionManager.operationSockets.set(operationId, operationSocket);

    try {
      if (this.requestProcessor.cancelledOperations.has(operationId)) {
        throw new DOMException("The user aborted a request.", "AbortError");
      }
      const operation = this.requestProcessor.execute(requestSpec, operationId);
      cancelTimeout = operation.cancelTimeout;
      const response = await operation.responsePromise;
      reader = response.body ? response.body.getReader() : null;
      if (this.requestProcessor.cancelledOperations.has(operationId)) {
        throw new DOMException("The user aborted a request.", "AbortError");
      }

      this._transmitHeaders(response, operationId);
      const textDecoder = new TextDecoder();
      let fullBody = "";

      // [Core fix] Correctly dispatch streaming and non-streaming data inside the loop
      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = textDecoder.decode(value, { stream: true });

        if (mode === "real") {
          // Streaming mode: forward each chunk immediately
          this._transmitChunk(chunk, operationId);
        } else {
          // fake mode
          // Non-streaming mode: concatenate chunks and forward once at the end
          fullBody += chunk;
        }
      }

      const tail = textDecoder.decode();
      if (mode === "real") this._transmitChunk(tail, operationId);
      else fullBody += tail;
      Logger.output("Finished reading data stream.");

      if (mode === "fake") {
        // In non-streaming mode, forward the assembled response after the loop
        this._transmitChunk(fullBody, operationId);
      }

      this._transmitStreamEnd(operationId);
    } catch (error) {
      if (error.name === "AbortError") {
        Logger.output(`[Diagnostic] Operation #${operationId} was aborted by the user.`);
      } else {
        Logger.output(`❌ Request processing failed: ${error.message}`);
      }
      this._sendErrorResponse(error, operationId);
    } finally {
      cancelTimeout();
      try {
        if (reader) {
          await reader.cancel();
          reader.releaseLock();
        }
        settled = true;
      } catch {
        // Uncertain cleanup must not release the server-side worker.
        settled = false;
      }
      if (settled) {
        this.requestProcessor.activeOperations.delete(operationId);
        this.requestProcessor.cancelledOperations.delete(operationId);
        if (this.connectionManager.socket === operationSocket) {
          this.connectionManager.transmit({
            event_type: "operation_done", request_id: operationId
          });
        }
        this.connectionManager.operationSockets.delete(operationId);
      }
    }
  }

  _transmitHeaders(response, operationId) {
    const headerMap = {};
    response.headers.forEach((v, k) => {
      headerMap[k] = v;
    });
    this.connectionManager.transmit({
      request_id: operationId,
      event_type: "response_headers",
      status: response.status,
      headers: headerMap,
    });
  }

  _transmitChunk(chunk, operationId) {
    if (!chunk) return;
    this.connectionManager.transmit({
      request_id: operationId,
      event_type: "chunk",
      data: chunk,
    });
  }

  _transmitStreamEnd(operationId) {
    this.connectionManager.transmit({
      request_id: operationId,
      event_type: "stream_close",
    });
    Logger.output("Task complete; sent stream-end signal");
  }

  _sendErrorResponse(error, operationId) {
    if (!operationId) return;
    this.connectionManager.transmit({
      request_id: operationId,
      event_type: "error",
      status: error.status || 504,
      retry_after: error.retryAfter || undefined,
      message: `Proxy browser error: ${error.message || "Unknown error"}`,
    });
    // --- 核心修改：Use different log wording by error type ---
    if (error.name === "AbortError") {
      Logger.output("Sent aborted status to server");
    } else {
      Logger.output("Sent error details to server");
    }
  }
}

async function initializeProxySystem() {
  try {
    Logger.output(
      "Bridge diagnostics:",
      `ProxySystem=${typeof ProxySystem}`,
      `prototype.initialize=${typeof ProxySystem.prototype.initialize}`,
    );

    const proxySystem = new ProxySystem();
    Logger.output(
      "Bridge instance diagnostics:",
      `initialize=${typeof proxySystem.initialize}`,
      `prototype=${Object.getPrototypeOf(proxySystem)?.constructor?.name}`,
    );

    if (typeof proxySystem.initialize !== "function") {
      throw new Error("Bridge initialization method is unavailable");
    }

    await proxySystem.initialize();
  } catch (error) {
    console.error("Proxy system failed to start:", error);
    Logger.output("Proxy system failed to start:", error.message);
  }
}

initializeProxySystem();
})();
