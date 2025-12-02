/**
 * SOLUTION #10: Request Validation with Joi
 * Centralized validation schemas for API endpoints
 */

const Joi = require('joi');

// ============================================================================
// VALIDATION SCHEMAS
// ============================================================================

// Common field patterns
const userId = Joi.string().pattern(/^user_\d+_\d+$/).required();
const optionalUserId = Joi.string().pattern(/^user_\d+_\d+$/).allow(null, '');
const callId = Joi.string().required();
const phoneNumber = Joi.string().pattern(/^\d{10,15}$/).allow(null, '');
const amount = Joi.number().positive();
const coinRate = Joi.number().min(1).max(1000);

// Schema definitions for each endpoint
const schemas = {
  // User endpoints
  checkAvailability: Joi.object({
    recipient_id: userId
  }),

  updateAvailability: Joi.object({
    user_id: userId,
    is_available: Joi.boolean().required()
  }),

  // Call endpoints
  initiateCall: Joi.object({
    caller_id: userId,
    recipient_id: userId,
    call_type: Joi.string().valid('audio', 'video').default('audio'),
    room_name: Joi.string().allow(null, ''),
    coin_rate: coinRate.default(10)
  }),

  acceptCall: Joi.object({
    call_id: callId,
    recipient_id: userId,
    caller_id: optionalUserId
  }),

  declineCall: Joi.object({
    call_id: callId,
    recipient_id: userId,
    caller_id: optionalUserId,
    reason: Joi.string().allow(null, '')
  }),

  endCall: Joi.object({
    call_id: callId,
    user_id: userId,
    duration: Joi.number().min(0).default(0),
    end_reason: Joi.string().allow(null, '')
  }),

  cancelCall: Joi.object({
    call_id: callId,
    caller_id: userId,
    recipient_id: optionalUserId
  }),

  // Twilio token
  twilioToken: Joi.object({
    identity: Joi.string().required(),
    room: Joi.string().required()
  }),

  // Payment endpoints
  createOrder: Joi.object({
    amount: amount.required(),
    currency: Joi.string().default('INR'),
    receipt: Joi.string().allow(null, ''),
    notes: Joi.object().allow(null)
  }),

  verifyPayment: Joi.object({
    razorpay_order_id: Joi.string().required(),
    razorpay_payment_id: Joi.string().required(),
    razorpay_signature: Joi.string().required()
  }),

  addCoins: Joi.object({
    user_id: userId,
    coins: Joi.number().integer().positive().required(),
    payment_id: Joi.string().allow(null, ''),
    reason: Joi.string().allow(null, '')
  }),

  // Payout endpoints
  syncPaymentAccount: Joi.object({
    userId: userId,
    userName: Joi.string().required(),
    phoneNumber: phoneNumber.required(),
    account: Joi.object({
      accountHolderName: Joi.string().min(3).required(),
      accountNumber: Joi.string().pattern(/^\d{8,18}$/).required(),
      ifscCode: Joi.string().pattern(/^[A-Z]{4}0[A-Z0-9]{6}$/).required(),
      bankName: Joi.string().allow(null, ''),
      upiId: Joi.string().pattern(/^[\w.\-]{2,}@[a-zA-Z]{2,}$/).allow(null, ''),
      accountType: Joi.string().valid('savings', 'current').default('savings')
    }).required()
  }),

  requestPayout: Joi.object({
    userId: userId,
    amount: amount.required(),
    fundAccountId: Joi.string().required(),
    mode: Joi.string().valid('NEFT', 'IMPS', 'UPI').default('IMPS')
  }),

  // FCM token
  registerFcmToken: Joi.object({
    user_id: userId,
    fcm_token: Joi.string().min(10).required()
  })
};

// ============================================================================
// VALIDATION MIDDLEWARE FACTORY
// ============================================================================

/**
 * Creates a validation middleware for a specific schema
 * @param {string} schemaName - Name of the schema to use
 * @param {string} source - 'body', 'query', or 'params'
 * @returns {Function} Express middleware
 */
function validate(schemaName, source = 'body') {
  return (req, res, next) => {
    const schema = schemas[schemaName];
    if (!schema) {
      console.error(`Validation schema "${schemaName}" not found`);
      return next();
    }

    const dataToValidate = source === 'body' ? req.body :
                           source === 'query' ? req.query : req.params;

    const { error, value } = schema.validate(dataToValidate, {
      abortEarly: false, // Return all errors, not just the first
      stripUnknown: true, // Remove unknown fields
      convert: true // Convert types (e.g., string to number)
    });

    if (error) {
      const errorDetails = error.details.map(d => ({
        field: d.path.join('.'),
        message: d.message
      }));

      console.warn(`⚠️ Validation failed for ${schemaName}:`, errorDetails);

      return res.status(400).json({
        error: 'Validation failed',
        details: errorDetails
      });
    }

    // Replace request data with validated/sanitized data
    if (source === 'body') {
      req.body = value;
    } else if (source === 'query') {
      req.query = value;
    } else {
      req.params = value;
    }

    next();
  };
}

/**
 * Validates socket event data
 * @param {string} schemaName - Name of the schema to use
 * @param {object} data - Data to validate
 * @returns {{ valid: boolean, data?: object, error?: string }}
 */
function validateSocketData(schemaName, data) {
  const schema = schemas[schemaName];
  if (!schema) {
    return { valid: true, data }; // No schema = no validation
  }

  const { error, value } = schema.validate(data, {
    abortEarly: false,
    stripUnknown: true,
    convert: true
  });

  if (error) {
    const messages = error.details.map(d => d.message).join(', ');
    return { valid: false, error: messages };
  }

  return { valid: true, data: value };
}

module.exports = {
  validate,
  validateSocketData,
  schemas
};
