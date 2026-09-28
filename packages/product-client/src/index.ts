import {
  ErrorEnvelopeSchema,
  type ErrorEnvelope,
} from "@turnsu/workbench-contracts/common";
import {
  WORKBENCH_API_PREFIX,
  type WorkbenchEndpointMetadata,
} from "@turnsu/workbench-contracts/endpoint-core";
import {
  Check,
  type Static,
  type TSchema,
} from "@turnsu/workbench-contracts/value";

export type JsonProductEndpoint = WorkbenchEndpointMetadata & {
  readonly responseMediaType: "application/json";
};

export type ProductOperationId<
  Endpoints extends readonly JsonProductEndpoint[],
> = Endpoints[number]["operationId"];

type EndpointFor<
  Endpoints extends readonly JsonProductEndpoint[],
  OperationId extends ProductOperationId<Endpoints>,
> = Extract<
  Endpoints[number],
  { operationId: OperationId }
>;

type SchemaValue<
  Endpoint,
  Key extends keyof Endpoint,
> = Endpoint[Key] extends TSchema ? Static<Endpoint[Key]> : never;

type RequiredKeys<Value extends object> = {
  [Key in keyof Value]-?: object extends Pick<Value, Key> ? never : Key;
}[keyof Value];

type InputField<
  Name extends string,
  Value extends object,
> = [RequiredKeys<Value>] extends [never]
  ? { [Key in Name]?: Value }
  : { [Key in Name]: Value };

type RequestBodyField<Endpoint> = Endpoint extends {
  requestBodySchema: infer Schema extends TSchema;
}
  ? { body: Static<Schema> }
  : { body?: never };

export type ProductCallInput<
  Endpoints extends readonly JsonProductEndpoint[],
  OperationId extends ProductOperationId<Endpoints>,
  Endpoint = EndpointFor<Endpoints, OperationId>,
> = Endpoint extends JsonProductEndpoint
  ? InputField<
      "pathParams",
      SchemaValue<Endpoint, "pathParamsSchema">
    > &
      InputField<"query", SchemaValue<Endpoint, "querySchema">> &
      InputField<
        "headers",
        SchemaValue<Endpoint, "requestHeadersSchema">
      > &
      RequestBodyField<Endpoint>
  : never;

export type ProductCallResponse<
  Endpoints extends readonly JsonProductEndpoint[],
  OperationId extends ProductOperationId<Endpoints>,
  Endpoint = EndpointFor<Endpoints, OperationId>,
> = Endpoint extends JsonProductEndpoint
  ? {
      operationId: OperationId;
      status: Endpoint["successStatus"];
      body: SchemaValue<Endpoint, "responseBodySchema">;
      headers: SchemaValue<Endpoint, "responseHeadersSchema">;
    }
  : never;

export interface ProductTransportRequest {
  readonly operationId: string;
  readonly method: WorkbenchEndpointMetadata["method"];
  readonly path: string;
  readonly mutation: boolean;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal?: AbortSignal;
}

export interface ProductTransportResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: Pick<Headers, "get">;
  json(): Promise<unknown>;
}

export interface ProductTransport {
  send(request: ProductTransportRequest): Promise<ProductTransportResponse>;
}

export type ProductClientProtocolStage =
  | "operation"
  | "request_path"
  | "request_query"
  | "request_headers"
  | "request_body"
  | "response_status"
  | "response_body"
  | "response_headers"
  | "error_body"
  | "transport";

export class ProductClientProtocolError extends Error {
  readonly code: string;
  readonly operationId: string;
  readonly stage: ProductClientProtocolStage;
  readonly status: number | undefined;

  constructor({
    code,
    operationId,
    stage,
    status,
    cause,
  }: {
    code: string;
    operationId: string;
    stage: ProductClientProtocolStage;
    status?: number;
    cause?: unknown;
  }) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = "ProductClientProtocolError";
    this.code = code;
    this.operationId = operationId;
    this.stage = stage;
    this.status = status;
  }
}

export class ProductApiError extends Error {
  readonly code: string;
  readonly details: ErrorEnvelope["details"];
  readonly retryable: boolean;
  readonly requestId: string;
  readonly status: number;

  constructor(envelope: ErrorEnvelope, status: number) {
    super(envelope.message);
    this.name = "ProductApiError";
    this.code = envelope.code;
    this.details = envelope.details;
    this.retryable = envelope.retryable;
    this.requestId = envelope.requestId;
    this.status = status;
  }
}

export interface ProductClientCallOptions {
  readonly signal?: AbortSignal;
}

export interface ProductClient<
  Endpoints extends readonly JsonProductEndpoint[],
> {
  call<OperationId extends ProductOperationId<Endpoints>>(
    operationId: OperationId,
    input: ProductCallInput<Endpoints, OperationId>,
    options?: ProductClientCallOptions,
  ): Promise<ProductCallResponse<Endpoints, OperationId>>;
}

export interface BrowserSessionTransportOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly basePath?: string;
  readonly csrfToken?: (operationId: string) => string | undefined;
}

export interface NativeTokenTransportOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly baseUrl: string;
  readonly accessToken: () => string | undefined;
}

/**
 * Native authorization-code and refresh exchanges happen before a bearer token
 * exists (or after it has expired). They deliberately omit browser cookies and
 * do not attach an Authorization header.
 */
export interface NativeCredentialExchangeTransportOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly baseUrl: string;
}

function protocolError(
  operationId: string,
  stage: ProductClientProtocolStage,
  code: string,
  status?: number,
  cause?: unknown,
): ProductClientProtocolError {
  return new ProductClientProtocolError({
    code,
    operationId,
    stage,
    ...(status === undefined ? {} : { status }),
    ...(cause === undefined ? {} : { cause }),
  });
}

function check(
  operationId: string,
  stage: ProductClientProtocolStage,
  schema: TSchema,
  value: unknown,
): void {
  if (!Check(schema, value)) {
    throw protocolError(
      operationId,
      stage,
      `product_client_invalid_${stage}`,
    );
  }
}

function encodePath(
  operationId: string,
  template: string,
  pathParams: Record<string, unknown>,
): string {
  return template.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    const value = pathParams[name];
    if (typeof value !== "string" && typeof value !== "number") {
      throw protocolError(
        operationId,
        "request_path",
        "product_client_invalid_request_path",
      );
    }
    return encodeURIComponent(String(value));
  });
}

function appendQueryValue(
  operationId: string,
  query: URLSearchParams,
  key: string,
  value: unknown,
): void {
  if (value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) appendQueryValue(operationId, query, key, item);
    return;
  }
  if (
    typeof value !== "string" &&
    typeof value !== "number" &&
    typeof value !== "boolean"
  ) {
    throw protocolError(
      operationId,
      "request_query",
      "product_client_invalid_request_query",
    );
  }
  query.append(key, String(value));
}

function encodeQuery(
  operationId: string,
  values: Record<string, unknown>,
): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    appendQueryValue(operationId, query, key, value);
  }
  const encoded = query.toString();
  return encoded.length > 0 ? `?${encoded}` : "";
}

function stringHeaders(
  operationId: string,
  values: Record<string, unknown>,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(values)) {
    if (typeof value !== "string") {
      throw protocolError(
        operationId,
        "request_headers",
        "product_client_invalid_request_headers",
      );
    }
    headers[name] = value;
  }
  return headers;
}

function declaredResponseHeaders(
  endpoint: JsonProductEndpoint,
  headers: Pick<Headers, "get">,
): Record<string, string> {
  return Object.fromEntries(
    endpoint.responseHeaders.map((name) => [name, headers.get(name) ?? ""]),
  );
}

export function createProductClient<
  const Endpoints extends readonly JsonProductEndpoint[],
>(
  endpoints: Endpoints,
  transport: ProductTransport,
): ProductClient<Endpoints> {
  const callableEndpoints = new Map<string, JsonProductEndpoint>(
    endpoints.map((endpoint) => [endpoint.operationId, endpoint]),
  );
  return {
    async call<OperationId extends ProductOperationId<Endpoints>>(
      operationId: OperationId,
      input: ProductCallInput<Endpoints, OperationId>,
      options: ProductClientCallOptions = {},
    ): Promise<ProductCallResponse<Endpoints, OperationId>> {
      const endpoint = callableEndpoints.get(operationId);
      if (!endpoint) {
        throw protocolError(
          operationId,
          "operation",
          "product_client_unknown_or_non_json_operation",
        );
      }

      const untypedInput = input as {
        pathParams?: unknown;
        query?: unknown;
        headers?: unknown;
        body?: unknown;
      };
      const pathParams = untypedInput.pathParams ?? {};
      const query = untypedInput.query ?? {};
      const headers = untypedInput.headers ?? {};

      check(
        operationId,
        "request_path",
        endpoint.pathParamsSchema,
        pathParams,
      );
      check(operationId, "request_query", endpoint.querySchema, query);
      check(
        operationId,
        "request_headers",
        endpoint.requestHeadersSchema,
        headers,
      );

      let body: string | undefined;
      if ("requestBodySchema" in endpoint) {
        check(
          operationId,
          "request_body",
          endpoint.requestBodySchema,
          untypedInput.body,
        );
        body = JSON.stringify(untypedInput.body);
      } else if (untypedInput.body !== undefined) {
        throw protocolError(
          operationId,
          "request_body",
          "product_client_unexpected_request_body",
        );
      }

      const path = `${encodePath(
        operationId,
        endpoint.path,
        pathParams as Record<string, unknown>,
      )}${encodeQuery(operationId, query as Record<string, unknown>)}`;
      const requestHeaders = stringHeaders(
        operationId,
        headers as Record<string, unknown>,
      );

      let response: ProductTransportResponse;
      try {
        response = await transport.send({
          operationId,
          method: endpoint.method,
          path,
          mutation: endpoint.mutation,
          headers: requestHeaders,
          ...(body === undefined ? {} : { body }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
      } catch (error) {
        if (error instanceof ProductClientProtocolError) throw error;
        throw protocolError(
          operationId,
          "transport",
          "product_client_transport_failed",
          undefined,
          error,
        );
      }

      let responseBody: unknown;
      try {
        responseBody = await response.json();
      } catch (error) {
        throw protocolError(
          operationId,
          response.ok ? "response_body" : "error_body",
          response.ok
            ? "product_client_invalid_response_body"
            : "product_client_invalid_error_body",
          response.status,
          error,
        );
      }

      if (!response.ok) {
        if (!Check(ErrorEnvelopeSchema, responseBody)) {
          throw protocolError(
            operationId,
            "error_body",
            "product_client_invalid_error_body",
            response.status,
          );
        }
        throw new ProductApiError(responseBody, response.status);
      }

      if (response.status !== endpoint.successStatus) {
        throw protocolError(
          operationId,
          "response_status",
          "product_client_unexpected_success_status",
          response.status,
        );
      }

      check(
        operationId,
        "response_body",
        endpoint.responseBodySchema,
        responseBody,
      );
      const responseHeaders = declaredResponseHeaders(endpoint, response.headers);
      check(
        operationId,
        "response_headers",
        endpoint.responseHeadersSchema,
        responseHeaders,
      );

      return {
        operationId,
        status: endpoint.successStatus,
        body: responseBody,
        headers: responseHeaders,
      } as ProductCallResponse<Endpoints, OperationId>;
    },
  };
}

export function createBrowserSessionTransport(
  options: BrowserSessionTransportOptions = {},
): ProductTransport {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== "function") {
    throw new TypeError("product_client_fetch_required");
  }
  const basePath = options.basePath ?? WORKBENCH_API_PREFIX;
  if (
    !basePath.startsWith("/") ||
    basePath.startsWith("//") ||
    /[?#]/.test(basePath)
  ) {
    throw new TypeError("product_client_base_path_invalid");
  }

  return {
    async send(request): Promise<ProductTransportResponse> {
      if (!request.path.startsWith(`${WORKBENCH_API_PREFIX}/`)) {
        throw protocolError(
          request.operationId,
          "transport",
          "product_client_cross_origin_path_forbidden",
        );
      }

      const headers = new Headers(request.headers);
      headers.set("Accept", "application/json");
      if (request.body !== undefined) {
        headers.set("Content-Type", "application/json");
      }
      const csrfToken = request.mutation
        ? options.csrfToken?.(request.operationId)
        : undefined;
      if (csrfToken) headers.set("X-Workbench-CSRF", csrfToken);
      const requestPath = `${basePath}${request.path.slice(WORKBENCH_API_PREFIX.length)}`;

      return fetchImplementation(requestPath, {
        method: request.method,
        headers,
        ...(request.body === undefined ? {} : { body: request.body }),
        credentials: "same-origin",
        redirect: "error",
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
    },
  };
}

export function createBrowserSessionProductClient<
  const Endpoints extends readonly JsonProductEndpoint[],
>(
  endpoints: Endpoints,
  options: BrowserSessionTransportOptions = {},
): ProductClient<Endpoints> {
  return createProductClient(endpoints, createBrowserSessionTransport(options));
}

/**
 * Desktop and mobile use the same contract client as the browser, but carry a
 * short-lived native bearer token rather than a browser cookie or CSRF token.
 * The base URL is deliberately absolute: native shells are not served from the
 * Product API origin.
 */
export function createNativeTokenTransport(
  options: NativeTokenTransportOptions,
): ProductTransport {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== "function") {
    throw new TypeError("product_client_fetch_required");
  }
  const normalizedBaseUrl = normalizedNativeBaseUrl(options.baseUrl);
  if (typeof options.accessToken !== "function") {
    throw new TypeError("product_client_native_access_token_required");
  }

  return {
    async send(request): Promise<ProductTransportResponse> {
      if (!request.path.startsWith(`${WORKBENCH_API_PREFIX}/`)) {
        throw protocolError(
          request.operationId,
          "transport",
          "product_client_cross_origin_path_forbidden",
        );
      }
      const token = options.accessToken();
      if (typeof token !== "string" || !/^[A-Za-z0-9_-]{32,512}$/u.test(token)) {
        throw protocolError(
          request.operationId,
          "transport",
          "product_client_native_access_token_required",
        );
      }
      const headers = new Headers(request.headers);
      headers.set("Accept", "application/json");
      headers.set("Authorization", `Bearer ${token}`);
      if (request.body !== undefined) {
        headers.set("Content-Type", "application/json");
      }
      return fetchImplementation(`${normalizedBaseUrl}${request.path}`, {
        method: request.method,
        headers,
        ...(request.body === undefined ? {} : { body: request.body }),
        credentials: "omit",
        redirect: "error",
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
    },
  };
}

/**
 * Use this only for the native authorization-code start, completion, and
 * refresh endpoints. Authenticated Product API calls must use
 * createNativeTokenTransport instead.
 */
export function createNativeCredentialExchangeTransport(
  options: NativeCredentialExchangeTransportOptions,
): ProductTransport {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== "function") {
    throw new TypeError("product_client_fetch_required");
  }
  const normalizedBaseUrl = normalizedNativeBaseUrl(options.baseUrl);

  return {
    async send(request): Promise<ProductTransportResponse> {
      if (!request.path.startsWith(`${WORKBENCH_API_PREFIX}/`)) {
        throw protocolError(
          request.operationId,
          "transport",
          "product_client_cross_origin_path_forbidden",
        );
      }
      const headers = new Headers(request.headers);
      headers.set("Accept", "application/json");
      if (request.body !== undefined) {
        headers.set("Content-Type", "application/json");
      }
      headers.delete("Authorization");
      headers.delete("X-Workbench-CSRF");
      return fetchImplementation(`${normalizedBaseUrl}${request.path}`, {
        method: request.method,
        headers,
        ...(request.body === undefined ? {} : { body: request.body }),
        credentials: "omit",
        redirect: "error",
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
    },
  };
}

function normalizedNativeBaseUrl(baseUrlValue: string): string {
  let baseUrl: URL;
  try {
    baseUrl = new URL(baseUrlValue);
  } catch {
    throw new TypeError("product_client_native_base_url_invalid");
  }
  if (
    !/^https?:$/u.test(baseUrl.protocol)
    || baseUrl.username
    || baseUrl.password
    || baseUrl.hash
    || baseUrl.search
  ) {
    throw new TypeError("product_client_native_base_url_invalid");
  }
  return baseUrl.toString().replace(/\/$/u, "");
}

export function createNativeTokenProductClient<
  const Endpoints extends readonly JsonProductEndpoint[],
>(
  endpoints: Endpoints,
  options: NativeTokenTransportOptions,
): ProductClient<Endpoints> {
  return createProductClient(endpoints, createNativeTokenTransport(options));
}

export function createNativeCredentialExchangeProductClient<
  const Endpoints extends readonly JsonProductEndpoint[],
>(
  endpoints: Endpoints,
  options: NativeCredentialExchangeTransportOptions,
): ProductClient<Endpoints> {
  return createProductClient(
    endpoints,
    createNativeCredentialExchangeTransport(options),
  );
}
