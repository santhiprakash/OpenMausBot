package com.openmausbot.companion.ui

import com.openmausbot.companion.core.Bot
import com.openmausbot.companion.core.BotTask
import com.openmausbot.companion.core.Chat

/**
 * Separate contexts for an agent or a channel — the rules behind
 * `ios/App/TaskManagerView.swift`.
 *
 * Tasks are conversation navigation, not host configuration, which is why they
 * are a compact sheet rather than a screen.
 */
object TaskRules {
    const val UNTITLED = "Untitled task"

    /** The line that tells a task apart from a routine. */
    const val CONTEXT_FOOTER =
        "A task is one conversation and result. Routines create fresh tasks on a schedule."

    /** The agent's job, or what this sheet is for when it has none. */
    fun subtitle(bot: Bot): String = bot.title.ifEmpty { "Agent tasks" }

    fun subtitle(chat: Chat): String = when (chat) {
        is Chat.BotChat -> subtitle(chat.bot)
        is Chat.RoomChat -> "Channel tasks"
    }

    fun tasks(bot: Bot): List<BotTask> = bot.tasks.orEmpty()

    fun tasks(chat: Chat): List<BotTask> = when (chat) {
        is Chat.BotChat -> tasks(chat.bot)
        is Chat.RoomChat -> chat.room.tasks.orEmpty()
    }

    fun title(task: BotTask): String = task.title.ifEmpty { UNTITLED }

    fun isCurrent(task: BotTask, bot: Bot): Boolean = task.threadId == bot.threadId

    fun isCurrent(task: BotTask, chat: Chat): Boolean = task.threadId == chat.threadId

    /** A running bot is mid-turn; the harness refuses task changes underneath it. */
    fun canCreate(bot: Bot): Boolean = bot.busy != true

    fun canCreate(chat: Chat): Boolean = !chat.busy

    /** The last task cannot go — a bot without one has nowhere to talk. */
    fun canDelete(task: BotTask, bot: Bot): Boolean =
        tasks(bot).size > 1 && bot.busy != true && tasks(bot).any { it.threadId == task.threadId }

    fun canDelete(task: BotTask, chat: Chat): Boolean =
        tasks(chat).size > 1 && !chat.busy && tasks(chat).any { it.threadId == task.threadId }

    /**
     * Switching away from the task a bot is working in is the same refusal as
     * creating or deleting one, so the button says so rather than letting the
     * harness answer 409. Already being on a task is not a switch.
     */
    fun canSwitch(task: BotTask, bot: Bot): Boolean = bot.busy != true && !isCurrent(task, bot)

    fun canSwitch(task: BotTask, chat: Chat): Boolean = !chat.busy && !isCurrent(task, chat)

    /** Renaming is allowed while busy: it touches the label, not the thread. */
    fun canRename(bot: Bot): Boolean = true

    fun canRename(chat: Chat): Boolean = true
}

/**
 * The two title dialogs, whose enabling has to keep following the bot after they
 * are already on screen: a bot can start running while the dialog is open, and a
 * Create button that stays lit then just collects a 409.
 */
object TaskDialogRules {
    /** Live: [bot] is re-read from the stream on every frame. */
    fun createEnabled(bot: Bot): Boolean = TaskRules.canCreate(bot)
    fun createEnabled(chat: Chat): Boolean = TaskRules.canCreate(chat)

    /**
     * Renaming has no busy gate and no emptiness gate. iOS sends the field as
     * typed and the server labels an empty title as the untitled task — refusing
     * to submit it would be this screen inventing a rule the product does not
     * have.
     */
    fun renameEnabled(bot: Bot, title: String): Boolean = TaskRules.canRename(bot)
    fun renameEnabled(chat: Chat, title: String): Boolean = TaskRules.canRename(chat)

    /** Create trims, and an empty title means "let the harness name it". */
    fun createTitle(raw: String): String? = raw.trim().ifEmpty { null }

    /** Rename sends the field as typed, as iOS does. */
    fun renameTitle(raw: String): String = raw
}
