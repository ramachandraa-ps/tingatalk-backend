# TingaTalk Backend Server

Backend server for TingaTalk video calling app with WebSocket support and Twilio integration.

## Features

- **WebSocket Server**: Real-time communication for call coordination
- **Twilio Integration**: Access token generation for video calls
- **Call Management**: Handle call initiation, acceptance, decline, and ending
- **User Management**: Track online users and their connections
- **Rate Limiting**: Protect against abuse
- **CORS Support**: Cross-origin resource sharing enabled

## Prerequisites

- Node.js 16.0.0 or higher
- Twilio Account with Video API enabled
- Twilio credentials (Account SID, API Key SID, API Key Secret)

## Installation

1. **Clone the repository** (if not already done)
   ```bash
   cd backend
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Set up environment variables**
   ```bash
   cp .env.example .env
   ```
   
   Edit `.env` file with your Twilio credentials:
   ```env
   TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   TWILIO_API_KEY_SID=SKxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   TWILIO_API_KEY_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   PORT=3000
   NODE_ENV=development
   ```

4. **Start the server**
   ```bash
   # Development mode
   npm run dev
   
   # Production mode
   npm start
   ```

## API Endpoints

### Health Check
- **GET** `/api/health` - Server health status

### Twilio Integration
- **POST** `/api/twilio/token` - Generate Twilio access token
  ```json
  {
    "identity": "user123",
    "roomName": "room_abc123",
    "callerId": "user123",
    "recipientId": "user456"
  }
  ```

### Call Management
- **GET** `/api/call/:callId` - Get call status

## WebSocket Events

### Client to Server

#### Join
```javascript
socket.emit('join', {
  userId: 'user123',
  userType: 'male' // or 'female'
});
```

#### Initiate Call
```javascript
socket.emit('initiate_call', {
  callerId: 'user123',
  recipientId: 'user456',
  callType: 'video' // or 'audio'
});
```

#### Accept Call
```javascript
socket.emit('accept_call', {
  callId: 'call_123',
  callerId: 'user123',
  recipientId: 'user456'
});
```

#### Decline Call
```javascript
socket.emit('decline_call', {
  callId: 'call_123',
  callerId: 'user123',
  recipientId: 'user456'
});
```

#### End Call
```javascript
socket.emit('end_call', {
  callId: 'call_123',
  userId: 'user123'
});
```

### Server to Client

#### Incoming Call
```javascript
socket.on('incoming_call', (data) => {
  console.log('Incoming call:', data);
  // data: { callId, roomName, callerId, recipientId, callType, timestamp }
});
```

#### Call Accepted
```javascript
socket.on('call_accepted', (data) => {
  console.log('Call accepted:', data);
  // data: { callId, roomName, recipientId }
});
```

#### Call Declined
```javascript
socket.on('call_declined', (data) => {
  console.log('Call declined:', data);
  // data: { callId, reason }
});
```

## Twilio Setup

1. **Create Twilio Account**
   - Sign up at [twilio.com](https://www.twilio.com)
   - Verify your phone number

2. **Enable Video API**
   - Go to Console > Video
   - Enable Video API for your account

3. **Create API Key**
   - Go to Console > Account > API Keys & Tokens
   - Create new API Key
   - Note down the SID and Secret

4. **Get Account SID**
   - Find your Account SID in Console > Account > General

## Environment Variables

| Variable | Description | Required | Default |
|----------|-------------|----------|---------|
| `TWILIO_ACCOUNT_SID` | Twilio Account SID | Yes | - |
| `TWILIO_API_KEY_SID` | Twilio API Key SID | Yes | - |
| `TWILIO_API_KEY_SECRET` | Twilio API Key Secret | Yes | - |
| `PORT` | Server port | No | 3000 |
| `NODE_ENV` | Environment | No | development |
| `CORS_ORIGIN` | CORS origin | No | http://localhost:3000 |
| `RATE_LIMIT_WINDOW_MS` | Rate limit window | No | 900000 |
| `RATE_LIMIT_MAX_REQUESTS` | Max requests per window | No | 100 |

## Development

### Running in Development Mode
```bash
npm run dev
```

This uses `nodemon` for automatic restart on file changes.

### Testing WebSocket Connection
You can test the WebSocket connection using any WebSocket client:

```javascript
const io = require('socket.io-client');
const socket = io('http://localhost:3000');

socket.on('connect', () => {
  console.log('Connected to server');
  
  // Join as a user
  socket.emit('join', {
    userId: 'test_user',
    userType: 'male'
  });
});

socket.on('joined', (data) => {
  console.log('Joined:', data);
});
```

## Production Deployment

1. **Set NODE_ENV to production**
   ```env
   NODE_ENV=production
   ```

2. **Use PM2 for process management**
   ```bash
   npm install -g pm2
   pm2 start server.js --name tingatalk-backend
   ```

3. **Set up reverse proxy** (nginx/Apache)
   - Configure SSL/TLS
   - Set up proper CORS origins
   - Enable rate limiting

## Security Considerations

- **Rate Limiting**: Implemented to prevent abuse
- **CORS**: Configured for specific origins
- **Helmet**: Security headers enabled
- **Input Validation**: Validate all incoming data
- **Error Handling**: Proper error responses without sensitive data

## Monitoring

The server provides health check endpoint for monitoring:
- **GET** `/api/health` - Returns server status and metrics

## Troubleshooting

### Common Issues

1. **Twilio Credentials Error**
   - Verify your Twilio credentials are correct
   - Ensure Video API is enabled in your Twilio account

2. **CORS Issues**
   - Check CORS_ORIGIN environment variable
   - Ensure client is connecting from allowed origin

3. **WebSocket Connection Failed**
   - Check if port is available
   - Verify firewall settings
   - Check for proxy issues

### Logs

The server logs all important events:
- User connections/disconnections
- Call events (initiate, accept, decline, end)
- Token generation
- Errors and warnings

## Support

For issues and questions:
1. Check the logs for error messages
2. Verify environment variables
3. Test WebSocket connection
4. Check Twilio account status

