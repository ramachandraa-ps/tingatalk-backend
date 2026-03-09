// ============================================================================
// Custom Error Classes
// ============================================================================

export class AppError extends Error {
  constructor(message, statusCode = 500, isOperational = true) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    this.name = this.constructor.name;
  }
}

export class AuthenticationError extends AppError {
  constructor(message = 'Authentication required') {
    super(message, 401);
  }
}

export class AuthorizationError extends AppError {
  constructor(message = 'Access denied') {
    super(message, 403);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(message, 404);
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Invalid input') {
    super(message, 400);
  }
}

export class InsufficientBalanceError extends AppError {
  constructor(currentBalance, requiredBalance) {
    super(`Insufficient balance. Have: ${currentBalance}, Need: ${requiredBalance}`, 400);
    this.currentBalance = currentBalance;
    this.requiredBalance = requiredBalance;
  }
}

export class ConcurrentCallError extends AppError {
  constructor(message = 'User is already in a call') {
    super(message, 409);
  }
}

export class DuplicatePaymentError extends AppError {
  constructor(existingData) {
    super('Payment already verified', 409);
    this.existingData = existingData;
  }
}
