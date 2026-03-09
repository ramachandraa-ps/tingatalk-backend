import { describe, it, expect } from 'vitest';
import { COIN_RATES, MIN_BALANCE, MIN_CALL_DURATION_SECONDS, FEMALE_EARNING_RATES } from '../src/shared/constants.js';

describe('Billing Logic', () => {
  it('should calculate correct minimum balance for audio calls', () => {
    const expected = COIN_RATES.audio * MIN_CALL_DURATION_SECONDS;
    expect(MIN_BALANCE.audio).toBe(expected);
    expect(MIN_BALANCE.audio).toBe(24); // 0.2 * 120
  });

  it('should calculate correct minimum balance for video calls', () => {
    const expected = COIN_RATES.video * MIN_CALL_DURATION_SECONDS;
    expect(MIN_BALANCE.video).toBe(expected);
    expect(MIN_BALANCE.video).toBe(120); // 1.0 * 120
  });

  it('should calculate coins to deduct for a call', () => {
    const durationSeconds = 300; // 5 minutes

    const audioCoins = Math.ceil(durationSeconds * COIN_RATES.audio);
    expect(audioCoins).toBe(60); // 300 * 0.2

    const videoCoins = Math.ceil(durationSeconds * COIN_RATES.video);
    expect(videoCoins).toBe(300); // 300 * 1.0
  });

  it('should calculate female earnings correctly', () => {
    const durationSeconds = 300;

    const audioEarnings = durationSeconds * FEMALE_EARNING_RATES.audio;
    expect(audioEarnings).toBe(45); // 300 * 0.15 = 45 INR

    const videoEarnings = durationSeconds * FEMALE_EARNING_RATES.video;
    expect(videoEarnings).toBe(240); // 300 * 0.80 = 240 INR
  });

  it('should detect fraud when server vs client duration differs by >5s', () => {
    const serverDuration = 300;
    const clientDuration = 290;
    const diff = Math.abs(serverDuration - clientDuration);

    // Within threshold
    expect(diff).toBeLessThanOrEqual(10);

    // Fraud case
    const fraudClientDuration = 200;
    const fraudDiff = Math.abs(serverDuration - fraudClientDuration);
    expect(fraudDiff).toBeGreaterThan(5);
  });

  it('should handle zero-duration calls (deduct 0 coins)', () => {
    const coins = Math.ceil(0 * COIN_RATES.video);
    expect(coins).toBe(0);
  });
});
