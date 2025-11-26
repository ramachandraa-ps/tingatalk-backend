/**
 * Stats Synchronization Utility
 * 
 * Handles synchronization of user statistics between PowerUps subcollection
 * and main user document for better performance and data consistency.
 * 
 * Features:
 * - Calculates fresh stats from PowerUps subcollection
 * - Updates main user document with calculated stats
 * - Provides fallback mechanisms for failed queries
 * - Validates data consistency
 */

const logger = require('../logger');

class StatsSyncUtil {
  constructor(firestore) {
    this.firestore = firestore;
    this.logger = logger;
  }

  /**
   * Get user stats with fallback mechanism
   * 
   * @param {string} userId - User ID
   * @returns {Promise<Object>} User stats object
   */
  async getUserStatsWithFallback(userId) {
    try {
      this.logger.info(`📊 Getting stats with fallback for user: ${userId}`);

      // Get main user document first (for fallback data)
      const userDoc = await this.firestore.collection('users').doc(userId).get();
      
      if (!userDoc.exists) {
        this.logger.warn(`📊 User document not found: ${userId}`);
        return this.getDefaultStats(userId);
      }

      const userData = userDoc.data();
      
      // Extract fallback stats from main document
      const fallbackStats = {
        userId: userId,
        rating: userData.rating || 0,
        totalCalls: userData.totalCallsReceived || 0,
        totalLikes: userData.totalLikes || 0,
        totalDislikes: userData.totalDislikes || 0,
        source: 'main_document'
      };

      this.logger.info(`📊 Fallback stats from main doc: ${JSON.stringify(fallbackStats)}`);

      // Try to get fresh stats from PowerUps subcollection
      try {
        const powerUpsSnapshot = await this.firestore
          .collection('users')
          .doc(userId)
          .collection('powerups')
          .get();

        if (!powerUpsSnapshot.empty) {
          let totalLikes = 0;
          let totalDislikes = 0;
          let totalCalls = powerUpsSnapshot.docs.length;

          powerUpsSnapshot.docs.forEach(doc => {
            const data = doc.data();
            if (data.like === true) totalLikes++;
            if (data.dislike === true) totalDislikes++;
          });

          // Calculate rating (0-10 scale)
          const rating = totalCalls > 0 
            ? parseFloat(((totalLikes / totalCalls) * 10).toFixed(1))
            : 0;

          const freshStats = {
            userId: userId,
            rating: rating,
            totalCalls: totalCalls,
            totalLikes: totalLikes,
            totalDislikes: totalDislikes,
            source: 'powerups_subcollection'
          };

          this.logger.info(`📊 Fresh stats from PowerUps: ${JSON.stringify(freshStats)}`);

          // Update main document with fresh stats (async, non-blocking)
          this.updateMainDocumentStats(userId, freshStats).catch(err => {
            this.logger.error(`📊 Failed to update main document stats: ${err.message}`);
          });

          return freshStats;
        } else {
          this.logger.info(`📊 PowerUps subcollection empty for user ${userId}, using fallback`);
          return fallbackStats;
        }
      } catch (subcollectionError) {
        this.logger.warn(`📊 PowerUps subcollection query failed for user ${userId}: ${subcollectionError.message}`);
        return fallbackStats;
      }
    } catch (error) {
      this.logger.error(`📊 Error getting user stats for ${userId}: ${error.message}`);
      return this.getDefaultStats(userId);
    }
  }

  /**
   * Update main user document with calculated stats
   * 
   * @param {string} userId - User ID
   * @param {Object} stats - Stats object
   */
  async updateMainDocumentStats(userId, stats) {
    try {
      await this.firestore.collection('users').doc(userId).update({
        rating: stats.rating,
        totalCallsReceived: stats.totalCalls,
        totalLikes: stats.totalLikes,
        totalDislikes: stats.totalDislikes,
        lastStatsUpdate: new Date(),
        statsSource: stats.source
      });

      this.logger.info(`📊 Updated main document stats for user: ${userId}`);
    } catch (error) {
      this.logger.error(`📊 Error updating main document stats for ${userId}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get default stats for a user
   * 
   * @param {string} userId - User ID
   * @returns {Object} Default stats object
   */
  getDefaultStats(userId) {
    return {
      userId: userId,
      rating: 0,
      totalCalls: 0,
      totalLikes: 0,
      totalDislikes: 0,
      source: 'default'
    };
  }

  /**
   * Validate stats consistency between main document and subcollection
   * 
   * @param {string} userId - User ID
   * @returns {Promise<boolean>} True if consistent
   */
  async validateStatsConsistency(userId) {
    try {
      const mainDocStats = await this.getStatsFromMainDocument(userId);
      const subcollectionStats = await this.getStatsFromSubcollection(userId);

      if (!mainDocStats || !subcollectionStats) {
        return false;
      }

      // Allow small differences due to timing
      const ratingDiff = Math.abs(mainDocStats.rating - subcollectionStats.rating);
      const callsDiff = Math.abs(mainDocStats.totalCalls - subcollectionStats.totalCalls);
      const likesDiff = Math.abs(mainDocStats.totalLikes - subcollectionStats.totalLikes);

      const isConsistent = ratingDiff < 0.5 && callsDiff <= 2 && likesDiff <= 2;

      if (!isConsistent) {
        this.logger.warn(`📊 Stats inconsistency detected for user ${userId}:`);
        this.logger.warn(`   Main doc: ${JSON.stringify(mainDocStats)}`);
        this.logger.warn(`   Subcollection: ${JSON.stringify(subcollectionStats)}`);
      }

      return isConsistent;
    } catch (error) {
      this.logger.error(`📊 Error validating stats consistency for ${userId}: ${error.message}`);
      return false;
    }
  }

  /**
   * Get stats from main user document
   * 
   * @param {string} userId - User ID
   * @returns {Promise<Object|null>} Stats object or null
   */
  async getStatsFromMainDocument(userId) {
    try {
      const doc = await this.firestore.collection('users').doc(userId).get();
      if (!doc.exists) return null;

      const data = doc.data();
      return {
        userId: userId,
        rating: data.rating || 0,
        totalCalls: data.totalCallsReceived || 0,
        totalLikes: data.totalLikes || 0,
        totalDislikes: data.totalDislikes || 0,
        source: 'main_document'
      };
    } catch (error) {
      this.logger.error(`📊 Error getting stats from main document for ${userId}: ${error.message}`);
      return null;
    }
  }

  /**
   * Get stats from PowerUps subcollection
   * 
   * @param {string} userId - User ID
   * @returns {Promise<Object|null>} Stats object or null
   */
  async getStatsFromSubcollection(userId) {
    try {
      const snapshot = await this.firestore
        .collection('users')
        .doc(userId)
        .collection('powerups')
        .get();

      if (snapshot.empty) return null;

      let totalLikes = 0;
      let totalDislikes = 0;
      let totalCalls = snapshot.docs.length;

      snapshot.docs.forEach(doc => {
        const data = doc.data();
        if (data.like === true) totalLikes++;
        if (data.dislike === true) totalDislikes++;
      });

      const rating = totalCalls > 0 
        ? parseFloat(((totalLikes / totalCalls) * 10).toFixed(1))
        : 0;

      return {
        userId: userId,
        rating: rating,
        totalCalls: totalCalls,
        totalLikes: totalLikes,
        totalDislikes: totalDislikes,
        source: 'powerups_subcollection'
      };
    } catch (error) {
      this.logger.error(`📊 Error getting stats from subcollection for ${userId}: ${error.message}`);
      return null;
    }
  }

  /**
   * Batch update stats for multiple users
   * 
   * @param {Array<string>} userIds - Array of user IDs
   * @returns {Promise<Object>} Results object
   */
  async batchUpdateStats(userIds) {
    const results = {
      success: [],
      failed: [],
      total: userIds.length
    };

    this.logger.info(`📊 Starting batch stats update for ${userIds.length} users`);

    for (const userId of userIds) {
      try {
        const stats = await this.getUserStatsWithFallback(userId);
        if (stats.source !== 'default') {
          await this.updateMainDocumentStats(userId, stats);
          results.success.push(userId);
        } else {
          results.failed.push({ userId, error: 'No valid stats found' });
        }
      } catch (error) {
        results.failed.push({ userId, error: error.message });
      }
    }

    this.logger.info(`📊 Batch stats update completed: ${results.success.length} success, ${results.failed.length} failed`);
    return results;
  }
}

module.exports = StatsSyncUtil;