package com.openmausbot.companion.notifications

import com.openmausbot.companion.core.NotificationFrame

/**
 * Pure mapping from companion notify frames to Android channel + dedupe id.
 * JVM-testable; [LocalNotificationPoster] is the Android glue.
 */
object NotificationMapping {
    const val CHANNEL_BLOCKING = "approval_question"
    const val CHANNEL_DONE = "done"
    const val CHANNEL_ROUTINE_FAILED = "routine_failed"

    fun channelId(notification: NotificationFrame): String = when (notification.kind) {
        "approval", "question" -> CHANNEL_BLOCKING
        "routine-failed" -> CHANNEL_ROUTINE_FAILED
        else -> CHANNEL_DONE
    }

    /** Matches iOS: `openmaus.{threadId}.{seq}` (title fallback when seq is null). */
    fun dedupeId(notification: NotificationFrame, sequence: Int?): String {
        val suffix = sequence?.toString() ?: notification.title
        return "openmaus.${notification.threadId}.$suffix"
    }

    fun isHighImportance(notification: NotificationFrame): Boolean = notification.isBlocking
}
