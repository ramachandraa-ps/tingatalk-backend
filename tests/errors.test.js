import { describe, it, expect } from 'vitest';
import {
  AppError, AuthenticationError, AuthorizationError,
  NotFoundError, ValidationError, InsufficientBalanceError,
  ConcurrentCallError, DuplicatePaymentError
} from '../src/shared/errors.js';

describe('Custom Error Classes', () => {
  it('AppError should have correct defaults', () => {
    const err = new AppError('test error', 500);
    expect(err.message).toBe('test error');
    expect(err.statusCode).toBe(500);
    expect(err.isOperational).toBe(true);
    expect(err).toBeInstanceOf(Error);
  });

  it('AuthenticationError should be 401', () => {
    const err = new AuthenticationError();
    expect(err.statusCode).toBe(401);
    expect(err.message).toBe('Authentication required');
  });

  it('AuthorizationError should be 403', () => {
    const err = new AuthorizationError();
    expect(err.statusCode).toBe(403);
  });

  it('NotFoundError should be 404', () => {
    const err = new NotFoundError('User not found');
    expect(err.statusCode).toBe(404);
    expect(err.message).toBe('User not found');
  });

  it('ValidationError should be 400', () => {
    const err = new ValidationError('Bad input');
    expect(err.statusCode).toBe(400);
  });

  it('InsufficientBalanceError should include balance details', () => {
    const err = new InsufficientBalanceError(10, 100);
    expect(err.statusCode).toBe(400);
    expect(err.currentBalance).toBe(10);
    expect(err.requiredBalance).toBe(100);
    expect(err.message).toContain('Insufficient balance');
  });

  it('ConcurrentCallError should be 409', () => {
    const err = new ConcurrentCallError();
    expect(err.statusCode).toBe(409);
  });

  it('DuplicatePaymentError should be 409 with existing data', () => {
    const data = { orderId: 'abc' };
    const err = new DuplicatePaymentError(data);
    expect(err.statusCode).toBe(409);
    expect(err.existingData).toEqual(data);
  });
});
