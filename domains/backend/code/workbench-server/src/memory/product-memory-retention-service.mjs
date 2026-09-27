/** Product-owned expiry owner.  Persistence decides time from its trusted DB. */
export class ProductMemoryRetentionService {
  constructor({ persistence } = {}) {
    if (!persistence || typeof persistence.sweepExpired !== "function") {
      throw new TypeError("memory_retention_persistence_required");
    }
    this.persistence = persistence;
  }

  async sweepExpired({ limit = 500 } = {}) {
    const result = await this.persistence.sweepExpired({ limit });
    if (!result || !Number.isInteger(result.deletedCandidateCount)
      || !Number.isInteger(result.deletedMemoryCount)) {
      throw new TypeError("memory_retention_result_invalid");
    }
    return Object.freeze({ ...result });
  }
}
