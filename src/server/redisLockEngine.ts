/**
 * DeadLockIQ Redis Distributed Lock Engine
 *
 * Implements distributed lock acquisition, ownership validation, lease TTL expiration,
 * atomic check-and-release (Redis Lua equivalent), and failure simulation.
 */

import { LockRecord } from '../types/index.ts';
import { fencingManager } from './fencing.ts';

export interface LockAcquisitionResult {
  success: boolean;
  resourceId: string;
  txId: string;
  fencingToken?: number;
  currentHolderTxId?: string;
  expiresAt?: number;
  error?: string;
}

export interface LockReleaseResult {
  success: boolean;
  resourceId: string;
  txId: string;
  releasedFencingToken?: number;
  error?: string;
}

export class RedisLockEngine {
  private locks: Map<string, LockRecord> = new Map();
  private expirationTimers: Map<string, NodeJS.Timeout> = new Map();
  private isSimulatingFailure: boolean = false;
  private artificialLatencyMs: number = 0;
  private onLockExpiredCallback?: (lock: LockRecord) => void;

  constructor(onExpired?: (lock: LockRecord) => void) {
    this.onLockExpiredCallback = onExpired;
  }

  public setOnExpiredCallback(cb: (lock: LockRecord) => void) {
    this.onLockExpiredCallback = cb;
  }

  public setSimulateFailure(simulate: boolean) {
    this.isSimulatingFailure = simulate;
  }

  public setArtificialLatency(ms: number) {
    this.artificialLatencyMs = ms;
  }

  public isHealthy(): boolean {
    return !this.isSimulatingFailure;
  }

  /**
   * Acquire a lock atomically (Equivalent to: SET resource txId NX PX ttlMs)
   */
  public async acquire(
    resourceId: string,
    txId: string,
    workerId: string,
    ttlMs: number = 5000
  ): Promise<LockAcquisitionResult> {
    if (this.artificialLatencyMs > 0) {
      await new Promise(r => setTimeout(r, this.artificialLatencyMs));
    }

    if (this.isSimulatingFailure) {
      return {
        success: false,
        resourceId,
        txId,
        error: 'REDIS_CONNECTION_REFUSED: Cluster connection pool exhausted / node unreachable',
      };
    }

    const existingLock = this.locks.get(resourceId);
    const now = Date.now();

    // Check if current lock exists and is still valid
    if (existingLock) {
      if (existingLock.expiresAt > now) {
        if (existingLock.holderTxId === txId) {
          // Re-entrant / renewal
          existingLock.expiresAt = now + ttlMs;
          this.rescheduleExpiration(resourceId, ttlMs);
          return {
            success: true,
            resourceId,
            txId,
            fencingToken: existingLock.fencingToken,
            expiresAt: existingLock.expiresAt,
          };
        }

        // Lock is held by another transaction
        return {
          success: false,
          resourceId,
          txId,
          currentHolderTxId: existingLock.holderTxId,
          expiresAt: existingLock.expiresAt,
        };
      } else {
        // Expired lock: auto-evict
        this.evictExpired(resourceId);
      }
    }

    // Grant lock atomically
    const fencingToken = fencingManager.issueToken(resourceId, txId);
    const lockRecord: LockRecord = {
      resourceId,
      holderTxId: txId,
      holderWorkerId: workerId,
      fencingToken,
      acquiredAt: now,
      expiresAt: now + ttlMs,
      ttlMs,
      waitingTxIds: [],
    };

    this.locks.set(resourceId, lockRecord);
    this.rescheduleExpiration(resourceId, ttlMs);

    return {
      success: true,
      resourceId,
      txId,
      fencingToken,
      expiresAt: lockRecord.expiresAt,
    };
  }

  /**
   * Safe atomic release (Equivalent to Redis Lua script verifying ownership)
   *
   * if redis.call("get", KEYS[1]) == ARGV[1] then
   *   return redis.call("del", KEYS[1])
   * else
   *   return 0
   * end
   */
  public async release(
    resourceId: string,
    txId: string,
    providedFencingToken?: number
  ): Promise<LockReleaseResult> {
    if (this.artificialLatencyMs > 0) {
      await new Promise(r => setTimeout(r, this.artificialLatencyMs));
    }

    if (this.isSimulatingFailure) {
      return {
        success: false,
        resourceId,
        txId,
        error: 'REDIS_CONNECTION_REFUSED: Cannot execute lock release script',
      };
    }

    const currentLock = this.locks.get(resourceId);

    if (!currentLock) {
      return {
        success: false,
        resourceId,
        txId,
        error: `LOCK_NOT_FOUND: No active lease for resource ${resourceId}`,
      };
    }

    // Strict ownership verification
    if (currentLock.holderTxId !== txId) {
      return {
        success: false,
        resourceId,
        txId,
        error: `OWNERSHIP_VIOLATION: Lock held by ${currentLock.holderTxId}, cannot be released by ${txId}`,
      };
    }

    // Fencing token verification if provided
    if (providedFencingToken !== undefined && providedFencingToken !== currentLock.fencingToken) {
      return {
        success: false,
        resourceId,
        txId,
        error: `FENCING_MISMATCH: Lock fencing token is ${currentLock.fencingToken}, but provided ${providedFencingToken}`,
      };
    }

    // Clear timer and remove lock
    const timer = this.expirationTimers.get(resourceId);
    if (timer) {
      clearTimeout(timer);
      this.expirationTimers.delete(resourceId);
    }

    this.locks.delete(resourceId);

    return {
      success: true,
      resourceId,
      txId,
      releasedFencingToken: currentLock.fencingToken,
    };
  }

  public getLock(resourceId: string): LockRecord | undefined {
    const lock = this.locks.get(resourceId);
    if (!lock) return undefined;
    if (lock.expiresAt <= Date.now()) {
      this.evictExpired(resourceId);
      return undefined;
    }
    return { ...lock };
  }

  public getAllLocks(): LockRecord[] {
    const now = Date.now();
    const result: LockRecord[] = [];
    for (const [resId, lock] of this.locks.entries()) {
      if (lock.expiresAt <= now) {
        this.evictExpired(resId);
      } else {
        result.push({ ...lock });
      }
    }
    return result;
  }

  public getLocksHeldBy(txId: string): LockRecord[] {
    return this.getAllLocks().filter(l => l.holderTxId === txId);
  }

  private rescheduleExpiration(resourceId: string, ttlMs: number) {
    const existing = this.expirationTimers.get(resourceId);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      this.evictExpired(resourceId);
    }, ttlMs);

    this.expirationTimers.set(resourceId, timer);
  }

  private evictExpired(resourceId: string) {
    const lock = this.locks.get(resourceId);
    const timer = this.expirationTimers.get(resourceId);
    if (timer) {
      clearTimeout(timer);
      this.expirationTimers.delete(resourceId);
    }

    if (lock) {
      this.locks.delete(resourceId);
      if (this.onLockExpiredCallback) {
        this.onLockExpiredCallback(lock);
      }
    }
  }

  public reset() {
    for (const timer of this.expirationTimers.values()) {
      clearTimeout(timer);
    }
    this.expirationTimers.clear();
    this.locks.clear();
    this.isSimulatingFailure = false;
    this.artificialLatencyMs = 0;
  }
}
