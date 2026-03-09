// ============================================================================
// Standardized API Response Helpers
// ============================================================================

export function success(res, data = {}, statusCode = 200) {
  return res.status(statusCode).json({
    success: true,
    ...data,
    timestamp: new Date().toISOString()
  });
}

export function error(res, message, statusCode = 500, details = null) {
  const response = { error: message };
  if (details && process.env.NODE_ENV === 'development') {
    response.details = details;
  }
  return res.status(statusCode).json(response);
}
