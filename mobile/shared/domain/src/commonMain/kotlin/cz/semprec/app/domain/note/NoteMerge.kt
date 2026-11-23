package cz.semprec.app.domain.note

import cz.semprec.app.domain.InlineRun

/** Past this many cells of a comparison table, the local side is taken for what that table compares. */
const val NOTE_MERGE_MAX_CELLS = 4_000_000

/**
 * Merges what a device wrote in a note with what the server holds now, three ways against the version the device
 * last read (docs/adr/2026-11-23-note-edits-merge-three-ways-and-wait-on-the-device.md), so nothing either side
 * wrote is lost:
 * - Blocks are compared by their canonical Markdown alone. Blocks both sides kept unchanged are fixed points.
 * - Between fixed points, a stretch only one side changed takes that side's blocks; one both changed the same way is
 *   taken once; one they changed differently is paired position by position: a block changed on both sides is
 *   merged (its type, indent, done, toggle and page id from the side that changed each, the local side when both
 *   did; its text by character), a block deleted on one side and changed on the other keeps the change, and the
 *   blocks one side added are kept, the local ones first.
 * - Text is merged by character, each with its inline style: a stretch only one side changed takes that side's
 *   characters; both changing one stretch keep the local characters and then the remote ones.
 * - Past [NOTE_MERGE_MAX_CELLS] cells of a comparison table, the local side is taken for that part.
 * The result is canonical Markdown, and a block taken unchanged from one side keeps the lines that side had.
 */
object NoteMerge {
    /** One Markdown with the changes of [local] and of [remote] since [base]; a blank note holds no block. */
    fun merge(base: String, local: String, remote: String): String {
        val read = listOf(base, local, remote).mapIndexed { side, markdown ->
            var next = 0
            NoteDocument.parse(markdown) { "merge-$side-${++next}" }
        }
        val (baseRead, localRead, remoteRead) = read
        fun blocksOf(markdown: String, note: NoteRead) = if (markdown.isBlank()) emptyList() else note.blocks
        val blocks = threeWay(
            blocksOf(base, baseRead),
            blocksOf(local, localRead),
            blocksOf(remote, remoteRead),
            ::blockKey,
            ::conflictingBlocks,
        ) ?: localRead.blocks
        return NoteDocument.markdown(blocks, localRead.source + remoteRead.source)
    }

    /**
     * [next] with the ids of the blocks of [previous] it holds unchanged, paired by the longest common subsequence of
     * their content, so an editor showing [next] keeps its caret and its state on those blocks; the lines [next] was
     * read from follow the renamed blocks.
     */
    fun adopt(previous: List<NoteBlock>, next: NoteRead): NoteRead {
        val pairs = commonPairs(previous.map(::blockKey), next.blocks.map(::blockKey)) ?: return next
        val renames = pairs.associate { (before, after) -> next.blocks[after].id to previous[before].id }
        val blocks = next.blocks.map { block -> renames[block.id]?.let { block.copy(id = it) } ?: block }
        return NoteRead(blocks, next.source.renamed(renames))
    }

    private fun conflictingBlocks(
        base: List<NoteBlock>,
        local: List<NoteBlock>,
        remote: List<NoteBlock>,
    ): List<NoteBlock> {
        val merged = mutableListOf<NoteBlock>()
        base.indices.forEach { index ->
            val before = base[index]
            val mine = local.getOrNull(index)
            val theirs = remote.getOrNull(index)
            when {
                mine != null && theirs != null -> merged += mergedBlock(before, mine, theirs)
                mine != null -> if (blockKey(mine) != blockKey(before)) merged += mine
                theirs != null -> if (blockKey(theirs) != blockKey(before)) merged += theirs
            }
        }
        val added = local.drop(base.size)
        merged += added
        merged += remote.drop(base.size).filter { theirs -> added.none { blockKey(it) == blockKey(theirs) } }
        return merged
    }

    private fun mergedBlock(base: NoteBlock, local: NoteBlock, remote: NoteBlock): NoteBlock = when {
        blockKey(local) == blockKey(base) -> remote
        blockKey(remote) == blockKey(base) -> local
        blockKey(local) == blockKey(remote) -> local
        else -> local.copy(
            type = changed(base.type, local.type, remote.type),
            indent = changed(base.indent, local.indent, remote.indent),
            done = changed(base.done, local.done, remote.done),
            toggle = changed(base.toggle, local.toggle, remote.toggle),
            pageId = changed(base.pageId, local.pageId, remote.pageId),
            preservedType = changed(base.preservedType, local.preservedType, remote.preservedType),
            runs = mergedRuns(base.runs, local.runs, remote.runs),
        )
    }

    /** The value a side changed, the local one when both did. */
    private fun <T> changed(base: T, local: T, remote: T): T = if (local != base) local else remote

    private fun mergedRuns(base: List<InlineRun>, local: List<InlineRun>, remote: List<InlineRun>): List<InlineRun> {
        val merged = threeWay(glyphs(base), glyphs(local), glyphs(remote), { it }) { _, mine, theirs -> mine + theirs }
            ?: return local
        return runsOf(merged)
    }

    /** A block as its own canonical Markdown, which compares everything the Markdown keeps of it. */
    private fun blockKey(block: NoteBlock): String = NoteDocument.markdown(listOf(block.copy(id = BLOCK_KEY_ID)))

    private const val BLOCK_KEY_ID = "key"
}

/** One character of a block's text (a surrogate pair stays one) with the inline style of its run. */
private data class Glyph(val text: String, val style: InlineRun)

private fun glyphs(runs: List<InlineRun>): List<Glyph> = runs.flatMap { run ->
    val style = run.copy(text = "")
    val glyphs = mutableListOf<Glyph>()
    var index = 0
    while (index < run.text.length) {
        val pair = run.text[index].isHighSurrogate() && index + 1 < run.text.length &&
            run.text[index + 1].isLowSurrogate()
        val length = if (pair) 2 else 1
        glyphs += Glyph(run.text.substring(index, index + length), style)
        index += length
    }
    glyphs
}

private fun runsOf(glyphs: List<Glyph>): List<InlineRun> {
    val runs = mutableListOf<InlineRun>()
    glyphs.forEach { glyph ->
        val last = runs.lastOrNull()
        if (last != null && last.copy(text = "") == glyph.style) {
            runs[runs.lastIndex] = last.copy(text = last.text + glyph.text)
        } else {
            runs += glyph.style.copy(text = glyph.text)
        }
    }
    return runs
}

/**
 * A three-way merge of sequences: the elements both sides kept (by [key], the longest common subsequence against
 * [base]) are fixed points; between them a stretch only one side changed takes that side, one both changed alike is
 * taken once, and [conflict] decides the rest. `null` when a comparison would exceed [NOTE_MERGE_MAX_CELLS].
 */
private fun <T, K> threeWay(
    base: List<T>,
    local: List<T>,
    remote: List<T>,
    key: (T) -> K,
    conflict: (base: List<T>, local: List<T>, remote: List<T>) -> List<T>,
): List<T>? {
    val baseKeys = base.map(key)
    val toLocal = commonPairs(baseKeys, local.map(key))?.toMap()
    val toRemote = commonPairs(baseKeys, remote.map(key))?.toMap()
    if (toLocal == null || toRemote == null) return null
    val merged = mutableListOf<T>()
    var from = Triple(0, 0, 0)
    fun stretch(baseEnd: Int, localEnd: Int, remoteEnd: Int) {
        val before = base.subList(from.first, baseEnd)
        val mine = local.subList(from.second, localEnd)
        val theirs = remote.subList(from.third, remoteEnd)
        val (beforeKeys, mineKeys, theirsKeys) = Triple(before.map(key), mine.map(key), theirs.map(key))
        merged += when {
            mineKeys == beforeKeys -> theirs
            theirsKeys == beforeKeys || mineKeys == theirsKeys -> mine
            else -> conflict(before, mine, theirs)
        }
    }
    base.indices.forEach { index ->
        val inLocal = toLocal[index]
        val inRemote = toRemote[index]
        if (inLocal != null && inRemote != null) {
            stretch(index, inLocal, inRemote)
            merged += remote[inRemote]
            from = Triple(index + 1, inLocal + 1, inRemote + 1)
        }
    }
    stretch(base.size, local.size, remote.size)
    return merged
}

/**
 * The index pairs of a longest common subsequence of [first] and [second], in order; the shared start and end are
 * paired first and only the middle is compared in a table. `null` when that table would exceed
 * [NOTE_MERGE_MAX_CELLS].
 */
private fun <K> commonPairs(first: List<K>, second: List<K>): List<Pair<Int, Int>>? {
    var start = 0
    while (start < first.size && start < second.size && first[start] == second[start]) start += 1
    var firstEnd = first.size
    var secondEnd = second.size
    while (firstEnd > start && secondEnd > start && first[firstEnd - 1] == second[secondEnd - 1]) {
        firstEnd -= 1
        secondEnd -= 1
    }
    val rows = firstEnd - start
    val columns = secondEnd - start
    if (rows.toLong() * columns > NOTE_MERGE_MAX_CELLS) return null
    val middle = middlePairs(first.subList(start, firstEnd), second.subList(start, secondEnd))
        .map { (row, column) -> row + start to column + start }
    val head = (0 until start).map { it to it }
    val tail = (0 until first.size - firstEnd).map { firstEnd + it to secondEnd + it }
    return head + middle + tail
}

/** A longest common subsequence of [first] and [second] by a table of their suffixes. */
private fun <K> middlePairs(first: List<K>, second: List<K>): List<Pair<Int, Int>> {
    if (first.isEmpty() || second.isEmpty()) return emptyList()
    val width = second.size + 1
    val lengths = IntArray((first.size + 1) * width)
    for (row in first.indices.reversed()) {
        for (column in second.indices.reversed()) {
            lengths[row * width + column] = if (first[row] == second[column]) {
                lengths[(row + 1) * width + column + 1] + 1
            } else {
                maxOf(lengths[(row + 1) * width + column], lengths[row * width + column + 1])
            }
        }
    }
    val pairs = mutableListOf<Pair<Int, Int>>()
    var row = 0
    var column = 0
    while (row < first.size && column < second.size) {
        when {
            first[row] == second[column] -> {
                pairs += row to column
                row += 1
                column += 1
            }
            lengths[(row + 1) * width + column] >= lengths[row * width + column + 1] -> row += 1
            else -> column += 1
        }
    }
    return pairs
}
