/**
 * SOLUTION #15: Authentication Middleware
 * Protects sensitive endpoints like diagnostics
 */

const config = require('../config');

/**
 * API Key authentication middleware for diagnostic endpoints
 * Requires X-API-Key header matching DIAGNOSTIC_API_KEY env variable
 */
function requireDiagnosticAuth(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  const expectedKey = config.security.diagnosticApiKey;

  // In development, allow access without key if not configured
  if (!config.isProduction && !expectedKey) {
    return next();
  }

  // In production, require API key
  if (!expectedKey) {
    console.warn('DIAGNOSTIC_API_KEY not configured - diagnostic endpoints are disabled');
    return res.status(503).json({
      error: 'Service unavailable',
      message: 'Diagnostic endpoints are not configured'
    });
  }

  if (!apiKey) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'X-API-Key header is required'
    });
  }

  // Constant-time comparison to prevent timing attacks
  if (!safeCompare(apiKey, expectedKey)) {
    return res.status(403).json({
      error: 'Forbidden',
      message: 'Invalid API key'
    });
  }

  next();
}

/**
 * Constant-time string comparison to prevent timing attacks
 */
function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }

  if (a.length !== b.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Optional: IP-based access control for internal endpoints
 * Only allows access from specified IPs (localhost, internal network)
 */
function requireInternalAccess(req, res, next) {
  const clientIp = req.ip || req.connection.remoteAddress || '';

  // Allow localhost and internal IPs
  const allowedPatterns = [
    /^127\.0\.0\.1$/,
    /^::1$/,
    /^::ffff:127\.0\.0\.1$/,
    /^10\.\d+\.\d+\.\d+$/,
    /^192\.168\.\d+\.\d+$/,
    /^172\.(1[6-9]|2[0-9]|3[0-1])\.\d+\.\d+$/
  ];

  const isAllowed = allowedPatterns.some(pattern => pattern.test(clientIp));

  if (!isAllowed && config.isProduction) {
    return res.status(403).json({
      error: 'Forbidden',
      message: 'Access denied from external IP'
    });
  }

  next();
}

module.exports = {
  requireDiagnosticAuth,
  requireInternalAccess,
  safeCompare
};
