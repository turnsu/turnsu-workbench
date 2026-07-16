export class ProductStoreError extends Error {
  constructor(code, message = code, details = {}) {
    super(message);
    this.name = "ProductStoreError";
    this.code = code;
    this.details = details;
  }
}

export const storeError = (code, message, details) =>
  new ProductStoreError(code, message, details);
