// ============================================================================
// 🆕 SERVER-AUTHORITATIVE CALL BILLING API ENDPOINTS
// ============================================================================

// Get user balance from Firestore
app.get('/api/user/:userId/balance', async (req, res) => {
  try {
    const { userId } = req.params;
    
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }
    
    logger.info(`💰 Getting balance for user: ${userId}`);
    
    const balance = await scalability.getUserBalance(userId);
    
    if (balance === null) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    res.json({
      success: true,
      userId,
      balance,
      currency: 'coins',
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    logger.error('❌ Error getting user balance:', error);
    res.status(500).json({ 
      error: 'Failed to get user balance',
      details: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

// Start call - Server-side tracking
app.post('/api/calls/start', async (req, res) => {
  try {
    const { callId, callerId, recipientId, callType, roomName } = req.body;
    
    if (!callId || !callerId || !recipientId || !callType) {
      return res.status(400).json({ error: 'Missing required fields: callId, callerId, recipientId, callType' });
    }
    
    logger.info(`📞 Starting call: ${callId} (${callType})`);
    logger.info(`   Caller: ${callerId}, Recipient: ${recipientId}`);
    
    // Check caller balance
    const callerBalance = await scalability.getUserBalance(callerId);
    const requiredBalance = callType === 'video' ? MIN_BALANCE_VIDEO : MIN_BALANCE_AUDIO;
    
    if (callerBalance === null) {
      return res.status(404).json({ error: 'Caller not found' });
    }
    
    if (callerBalance < requiredBalance) {
      return res.status(400).json({ 
        error: 'Insufficient balance',
        currentBalance: callerBalance,
        requiredBalance,
        shortfall: requiredBalance - callerBalance
      });
    }
    
    // Check recipient availability
    const recipientStatus = await scalability.getUserStatus(recipientId);
    if (recipientStatus && recipientStatus.status === 'busy') {
      return res.status(409).json({ 
        error: 'Recipient is busy',
        recipientStatus: recipientStatus.status
      });
    }
    
    const coinRate = callType === 'video' ? COIN_RATES.video : COIN_RATES.audio;
    const startTime = Date.now();
    
    // Create call record in Firestore
    const callData = {
      callId,
      callerId,
      recipientId,
      callType,
      roomName: roomName || `${callType}_${callerId}_${recipientId}`,
      status: 'initiated',
      coinRate,
      startedAt: new Date().toISOString(),
      durationSeconds: 0,
      coinsDeducted: 0
    };
    
    await scalability.saveCallToFirestore(callData);
    
    // Start server-side timer
    const interval = setInterval(() => {
      const callTimer = callTimers.get(callId);
      if (callTimer) {
        callTimer.durationSeconds++;
        
        if (callTimer.durationSeconds % 10 === 0) {
          logger.debug(`⏱️  Call ${callId} duration: ${callTimer.durationSeconds}s`);
        }
      }
    }, 1000);
    
    callTimers.set(callId, {
      interval,
      startTime,
      durationSeconds: 0,
      callerId,
      recipientId,
      callType,
      coinRate,
      roomName: callData.roomName,
      lastHeartbeat: startTime // 🔧 FIX: Initialize lastHeartbeat to prevent immediate timeout
    });
    
    // Store in Redis and mark users as busy
    await setActiveCallSync(callId, callData);
    await setUserStatusSync(callerId, {
      status: 'busy',
      currentCallId: callId,
      lastStatusChange: new Date()
    });
    await setUserStatusSync(recipientId, {
      status: 'busy',
      currentCallId: callId,
      lastStatusChange: new Date()
    });
    
    logger.info(`✅ Call started: ${callId}`);
    
    res.json({
      success: true,
      callId,
      serverStartTime: new Date(startTime).toISOString(),
      coinRate,
      message: 'Call tracking started on server'
    });
    
  } catch (error) {
    logger.error('❌ Error starting call:', error);
    res.status(500).json({ 
      error: 'Failed to start call',
      details: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

// Complete call - Server-authoritative billing
app.post('/api/calls/complete', async (req, res) => {
  try {
    const { callId, callerId, recipientId, endReason } = req.body;
    
    if (!callId || !callerId || !recipientId) {
      return res.status(400).json({ error: 'Missing required fields: callId, callerId, recipientId' });
    }
    
    logger.info(`📞 Completing call: ${callId}`);
    
    // Get server-tracked duration (AUTHORITATIVE!)
    const serverTimer = callTimers.get(callId);
    
    if (!serverTimer) {
      logger.warn(`⚠️  No server timer found for call ${callId}`);
      return res.status(404).json({ error: 'Call not found or already completed' });
    }
    
    // Stop timer
    clearInterval(serverTimer.interval);
    const serverDuration = serverTimer.durationSeconds;
    const coinRate = serverTimer.coinRate;
    const coinsDeducted = Math.ceil(serverDuration * coinRate);
    
    logger.info(`   Duration: ${serverDuration}s, Coins: ${coinsDeducted}`);
    
    // Deduct coins from caller (Firestore Admin SDK)
    await scalability.deductUserCoins(callerId, coinsDeducted, callId);
    
    // Get caller balance after deduction
    const newBalance = await scalability.getUserBalance(callerId);
    
    // Determine if recipient is female and calculate earnings
    let femaleEarnings = 0;
    // For now, assume recipient is female (you can check in Firestore)
    // In a real implementation, you'd check user gender from Firestore
    const recipientGender = 'female'; // TODO: Get from Firestore
    
    if (recipientGender === 'female') {
      // Female gets 50% of coins as earnings
      femaleEarnings = Math.floor(coinsDeducted * 0.5);
      await scalability.updateUserEarnings(recipientId, femaleEarnings, callId);
      logger.info(`   Female earnings: ${femaleEarnings} coins`);
    }
    
    // Update call in Firestore
    await scalability.updateCallInFirestore(callId, {
      status: 'completed',
      endReason: endReason || 'normal',
      durationSeconds: serverDuration,
      coinsDeducted,
      endedAt: new Date().toISOString(),
      serverDurationSeconds: serverDuration
    });
    
    // Clean up
    callTimers.delete(callId);
    await deleteActiveCallSync(callId);
    await setUserStatusSync(callerId, {
      status: 'available',
      currentCallId: null,
      lastStatusChange: new Date()
    });
    await setUserStatusSync(recipientId, {
      status: 'available',
      currentCallId: null,
      lastStatusChange: new Date()
    });
    
    logger.info(`✅ Call completed: ${callId} - ${serverDuration}s, ${coinsDeducted} coins`);
    
    res.json({
      success: true,
      callId,
      durationSeconds: serverDuration,
      coinsDeducted,
      coinRate,
      newBalance,
      femaleEarnings,
      endReason: endReason || 'normal',
      message: 'Call completed and billed successfully'
    });
    
  } catch (error) {
    logger.error('❌ Error completing call:', error);
    res.status(500).json({ 
      error: 'Failed to complete call',
      details: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

// Heartbeat - Keep call alive and get current duration
app.post('/api/calls/heartbeat', async (req, res) => {
  try {
    const { callId, userId } = req.body;
    
    if (!callId || !userId) {
      return res.status(400).json({ error: 'Missing required fields: callId, userId' });
    }
    
    const serverTimer = callTimers.get(callId);
    
    if (!serverTimer) {
      return res.status(404).json({ error: 'Call not found' });
    }
    
    const currentDuration = serverTimer.durationSeconds;
    const estimatedCoins = Math.ceil(currentDuration * serverTimer.coinRate);
    
    // Update last heartbeat timestamp
    serverTimer.lastHeartbeat = Date.now();
    
    res.json({
      success: true,
      callId,
      currentDuration,
      estimatedCoins,
      coinRate: serverTimer.coinRate,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    logger.error('❌ Error processing heartbeat:', error);
    res.status(500).json({ 
      error: 'Failed to process heartbeat',
      details: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

logger.info('✅ Server-authoritative call billing API endpoints loaded');
