// Adaptive Rate Limiter and Circuit Breaker for Shoptet API
export function createAdaptiveRateLimiter({
  minDelayMs = 250,
  maxDelayMs = 5000,
  circuitBreakerThreshold = 3,
  circuitBreakerCooldownMs = 30000,
  sleep = ms => new Promise(r => setTimeout(r, ms))
} = {}) {
  let remainingBudget = 40;
  let resetSeconds = 10;
  let consecutiveFailures = 0;
  let circuitBreakerTrippedUntil = 0;

  return {
    get consecutiveFailures() { return consecutiveFailures; },
    get remainingBudget() { return remainingBudget; },
    get isCircuitOpen() { return Date.now() < circuitBreakerTrippedUntil; },

    observeResponse(response) {
      if (!response || !response.headers) return;
      const remainingH = response.headers.get('x-ratelimit-remaining');
      const resetH = response.headers.get('x-ratelimit-reset');
      if (remainingH !== null) {
        const val = parseInt(remainingH, 10);
        if (Number.isFinite(val)) remainingBudget = val;
      }
      if (resetH !== null) {
        const val = parseFloat(resetH);
        if (Number.isFinite(val)) resetSeconds = val;
      }

      if (response.status === 429) {
        consecutiveFailures++;
        const retryH = response.headers.get('retry-after');
        const retry = retryH !== null ? parseFloat(retryH) : NaN;
        resetSeconds = Number.isFinite(retry) ? Math.max(1, retry) : 10;
      } else if (response.status >= 500) {
        consecutiveFailures++;
      } else if (response.ok) {
        consecutiveFailures = 0;
      }

      if (consecutiveFailures >= circuitBreakerThreshold) {
        circuitBreakerTrippedUntil = Date.now() + circuitBreakerCooldownMs;
      }
    },

    observeError() {
      consecutiveFailures++;
      if (consecutiveFailures >= circuitBreakerThreshold) {
        circuitBreakerTrippedUntil = Date.now() + circuitBreakerCooldownMs;
      }
    },

    async waitBeforeNextRequest() {
      if (Date.now() < circuitBreakerTrippedUntil) {
        const waitMs = circuitBreakerTrippedUntil - Date.now();
        await sleep(waitMs);
        return { paced: true, reason: 'circuit_breaker_cooldown', waitMs };
      }

      if (remainingBudget <= 3) {
        const waitMs = Math.ceil(resetSeconds * 1000) + 200;
        await sleep(waitMs);
        remainingBudget = 20; // reset assumed after window
        return { paced: true, reason: 'exhausted_budget', waitMs };
      }

      if (remainingBudget <= 10) {
        const waitMs = 1000;
        await sleep(waitMs);
        return { paced: true, reason: 'low_budget_pacing', waitMs };
      }

      await sleep(minDelayMs);
      return { paced: true, reason: 'nominal_delay', waitMs: minDelayMs };
    }
  };
}
