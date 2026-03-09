import { logger } from './logger.js';

export class StatsSyncUtil {
  constructor(firestore) {
    this.firestore = firestore;
  }

  async getUserStatsWithFallback(userId) {
    try {
      const userDoc = await this.firestore.collection('users').doc(userId).get();
      if (!userDoc.exists) return this.getDefaultStats(userId);

      const userData = userDoc.data();
      const fallbackStats = {
        userId,
        rating: userData.rating || 0,
        totalCalls: userData.totalCallsReceived || 0,
        totalLikes: userData.totalLikes || 0,
        totalDislikes: userData.totalDislikes || 0,
        source: 'main_document'
      };

      try {
        const powerUpsSnapshot = await this.firestore
          .collection('users').doc(userId).collection('powerups').get();

        if (!powerUpsSnapshot.empty) {
          let totalLikes = 0;
          let totalDislikes = 0;
          const totalCalls = powerUpsSnapshot.docs.length;

          powerUpsSnapshot.docs.forEach(doc => {
            const data = doc.data();
            if (data.like === true) totalLikes++;
            if (data.dislike === true) totalDislikes++;
          });

          const rating = totalCalls > 0
            ? parseFloat(((totalLikes / totalCalls) * 10).toFixed(1))
            : 0;

          const freshStats = {
            userId, rating, totalCalls, totalLikes, totalDislikes,
            source: 'powerups_subcollection'
          };

          this.updateMainDocumentStats(userId, freshStats).catch(err =>
            logger.error(`Failed to update main document stats: ${err.message}`)
          );

          return freshStats;
        }
        return fallbackStats;
      } catch (subcollectionError) {
        logger.warn(`PowerUps query failed for ${userId}: ${subcollectionError.message}`);
        return fallbackStats;
      }
    } catch (error) {
      logger.error(`Error getting user stats for ${userId}: ${error.message}`);
      return this.getDefaultStats(userId);
    }
  }

  async updateMainDocumentStats(userId, stats) {
    await this.firestore.collection('users').doc(userId).update({
      rating: stats.rating,
      totalCallsReceived: stats.totalCalls,
      totalLikes: stats.totalLikes,
      totalDislikes: stats.totalDislikes,
      lastStatsUpdate: new Date(),
      statsSource: stats.source
    });
  }

  getDefaultStats(userId) {
    return {
      userId, rating: 0, totalCalls: 0, totalLikes: 0, totalDislikes: 0,
      source: 'default'
    };
  }

  async validateStatsConsistency(userId) {
    try {
      const mainDocStats = await this.getStatsFromMainDocument(userId);
      const subcollectionStats = await this.getStatsFromSubcollection(userId);
      if (!mainDocStats || !subcollectionStats) return false;

      const ratingDiff = Math.abs(mainDocStats.rating - subcollectionStats.rating);
      const callsDiff = Math.abs(mainDocStats.totalCalls - subcollectionStats.totalCalls);
      const likesDiff = Math.abs(mainDocStats.totalLikes - subcollectionStats.totalLikes);

      const isConsistent = ratingDiff < 0.5 && callsDiff <= 2 && likesDiff <= 2;
      if (!isConsistent) {
        logger.warn(`Stats inconsistency for ${userId}: main=${JSON.stringify(mainDocStats)}, sub=${JSON.stringify(subcollectionStats)}`);
      }
      return isConsistent;
    } catch (error) {
      logger.error(`Error validating stats consistency for ${userId}: ${error.message}`);
      return false;
    }
  }

  async getStatsFromMainDocument(userId) {
    try {
      const doc = await this.firestore.collection('users').doc(userId).get();
      if (!doc.exists) return null;
      const data = doc.data();
      return {
        userId, rating: data.rating || 0,
        totalCalls: data.totalCallsReceived || 0,
        totalLikes: data.totalLikes || 0,
        totalDislikes: data.totalDislikes || 0,
        source: 'main_document'
      };
    } catch (error) {
      logger.error(`Error getting stats from main doc for ${userId}: ${error.message}`);
      return null;
    }
  }

  async getStatsFromSubcollection(userId) {
    try {
      const snapshot = await this.firestore
        .collection('users').doc(userId).collection('powerups').get();
      if (snapshot.empty) return null;

      let totalLikes = 0;
      let totalDislikes = 0;
      const totalCalls = snapshot.docs.length;

      snapshot.docs.forEach(doc => {
        const data = doc.data();
        if (data.like === true) totalLikes++;
        if (data.dislike === true) totalDislikes++;
      });

      const rating = totalCalls > 0
        ? parseFloat(((totalLikes / totalCalls) * 10).toFixed(1))
        : 0;

      return {
        userId, rating, totalCalls, totalLikes, totalDislikes,
        source: 'powerups_subcollection'
      };
    } catch (error) {
      logger.error(`Error getting stats from subcollection for ${userId}: ${error.message}`);
      return null;
    }
  }

  async batchUpdateStats(userIds) {
    const results = { success: [], failed: [], total: userIds.length };
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
    return results;
  }
}
