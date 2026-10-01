/**
 * DeadLockIQ Fencing Token Manager
 *
 * Implements monotonically increasing 64-bit sequence tokens to protect
 * shared resources against stale workers (e.g. paused by GC, network partition,
 * or lease timeout).
 */

export interface FencingValidationResult {
  valid: boolean;
  resourceId: string;
  providedToken: number;
  expectedMinToken: number;
  reason?: string;
}

export class FencingTokenManager {
  private globalSequence: bigint = 1000n;
  private resourceLatestToken: Map<string, bigint> = new Map();
  private tokenHistory: { resourceId: string; token: number; txId: string; issuedAt: number }[] = [];
  private violationCount: number = 0;

  /**
   * Generates a new monotonically increasing fencing token for a granted lock
   */
  public issueToken(resourceId: string, txId: string): number {
    this.globalSequence += 1n;
    const token = this.globalSequence;
    this.resourceLatestToken.set(resourceId, token);

    const numericToken = Number(token);
    this.tokenHistory.unshift({
      resourceId,
      token: numericToken,
      txId,
      issuedAt: Date.now(),
    });

    if (this.tokenHistory.length > 50) {
      this.tokenHistory.pop();
    }

    return numericToken;
  }

  /**
   * Validates whether a worker's fencing token is still current and valid.
   * If a newer token was already issued for this resource, the worker is stale.
   */
  public validateToken(resourceId: string, providedToken: number): FencingValidationResult {
    const latest = this.resourceLatestToken.get(resourceId);

    if (!latest) {
      // If no token exists, the provided token is valid only if greater than 0
      return {
        valid: providedToken > 0,
        resourceId,
        providedToken,
        expectedMinToken: 1,
      };
    }

    const latestNumeric = Number(latest);

    if (providedToken < latestNumeric) {
      this.violationCount++;
      return {
        valid: false,
        resourceId,
        providedToken,
        expectedMinToken: latestNumeric,
        reason: `STALE_WORKER_REJECTED: Provided fencing token [${providedToken}] is older than current resource token [${latestNumeric}]. Mutating operation denied.`,
      };
    }

    return {
      valid: true,
      resourceId,
      providedToken,
      expectedMinToken: latestNumeric,
    };
  }

  public getLatestToken(resourceId: string): number {
    const token = this.resourceLatestToken.get(resourceId);
    return token ? Number(token) : 0;
  }

  public getHistory() {
    return [...this.tokenHistory];
  }

  public getViolationCount(): number {
    return this.violationCount;
  }

  public reset() {
    this.globalSequence = 1000n;
    this.resourceLatestToken.clear();
    this.tokenHistory = [];
    this.violationCount = 0;
  }
}

export const fencingManager = new FencingTokenManager();
