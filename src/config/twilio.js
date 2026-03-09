import twilio from 'twilio';
import { config } from './index.js';
import { logger } from '../utils/logger.js';
import { TWILIO_TOKEN_TTL } from '../shared/constants.js';

const { accountSid, apiKeySid, apiKeySecret } = config.twilio;

if (!accountSid || !apiKeySid || !apiKeySecret) {
  logger.error('Missing Twilio credentials. Set TWILIO_ACCOUNT_SID, TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET');
  process.exit(1);
}

const AccessToken = twilio.jwt.AccessToken;
const VideoGrant = AccessToken.VideoGrant;

export function generateAccessToken(identity, roomName, isVideo = true) {
  if (!identity || typeof identity !== 'string' || identity.length < 3) {
    throw new Error('Invalid identity: must be string with at least 3 characters');
  }
  if (!roomName || typeof roomName !== 'string' || roomName.length < 5) {
    throw new Error('Invalid roomName: must be string with at least 5 characters');
  }

  const token = new AccessToken(accountSid, apiKeySid, apiKeySecret, {
    identity,
    ttl: TWILIO_TOKEN_TTL
  });

  token.addGrant(new VideoGrant({ room: roomName }));

  logger.info(`Generated ${isVideo ? 'video' : 'audio'} token for ${identity} in room ${roomName}`);
  return token.toJwt();
}
