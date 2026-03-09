import { describe, it, expect } from 'vitest';

describe('Health Check', () => {
  it('should have constants properly defined', async () => {
    const { COIN_RATES, MIN_BALANCE, COIN_PACKAGES } = await import('../src/shared/constants.js');

    expect(COIN_RATES.audio).toBe(0.2);
    expect(COIN_RATES.video).toBe(1.0);
    expect(MIN_BALANCE.audio).toBe(24);
    expect(MIN_BALANCE.video).toBe(120);
    expect(Object.keys(COIN_PACKAGES)).toHaveLength(4);
  });

  it('should have all coin packages with required fields', async () => {
    const { COIN_PACKAGES } = await import('../src/shared/constants.js');

    for (const [id, pkg] of Object.entries(COIN_PACKAGES)) {
      expect(pkg).toHaveProperty('id', id);
      expect(pkg).toHaveProperty('name');
      expect(pkg).toHaveProperty('coinAmount');
      expect(pkg).toHaveProperty('priceInRupees');
      expect(pkg).toHaveProperty('isActive', true);
      expect(pkg.coinAmount).toBeGreaterThan(0);
      expect(pkg.priceInRupees).toBeGreaterThan(0);
    }
  });

  it('should define all user statuses', async () => {
    const { USER_STATUS } = await import('../src/shared/constants.js');

    expect(USER_STATUS.AVAILABLE).toBe('available');
    expect(USER_STATUS.BUSY).toBe('busy');
    expect(USER_STATUS.RINGING).toBe('ringing');
    expect(USER_STATUS.DISCONNECTED).toBe('disconnected');
  });

  it('should define all call statuses', async () => {
    const { CALL_STATUS } = await import('../src/shared/constants.js');

    expect(CALL_STATUS.INITIATED).toBe('initiated');
    expect(CALL_STATUS.ACTIVE).toBe('active');
    expect(CALL_STATUS.COMPLETED).toBe('completed');
    expect(CALL_STATUS.TIMEOUT_HEARTBEAT).toBe('timeout_heartbeat');
  });
});
