package dev.vpsdeck.ops

import dev.vpsdeck.ssh.ExecResult

/**
 * Server-side file snapshot: an index of paths and metadata built with find(1) in the
 * app's private host directory. No file content leaves the server until the user picks a hit.
 */
object FileIndex {
    const val DIR = "/var/lib/vpsdeck-private/filesnap"
    const val DEFAULT_MAX = 200_000
    const val SEARCH_LIMIT = 500
    const val NO_SNAPSHOT_EXIT = 72

    fun maxEntries(value: String): Int {
        val n = value.toIntOrNull() ?: error("上限必须是数字")
        require(n in 1_000..1_000_000) { "条目上限须在1000–1000000之间" }
        return n
    }

    /** Build command: prune pseudo filesystems and the index itself, cap entries, meta line last. */
    fun buildCommand(root: String, max: Int): String {
        val r = Shell.absolute(root.trim())
        val d = Shell.quote(DIR)
        val rootQ = Shell.quote(r)
        val prune = "-path /proc -o -path /sys -o -path /dev -o -path /run -o -path /snap -o -path " + DIR
        return listOf(
            "set -e",
            "dir=$d",
            "mkdir -p -- \"\$dir\"",
            "chmod 700 -- \"\$dir\"",
            "find $rootQ -xdev \\( $prune -o -path \"\$dir\" \\) -prune -o -printf '%y\\t%m\\t%s\\t%T@\\t%p\\n' 2>/dev/null | head -n $max > \"\$dir/index.tmp\"",
            "mv -f -- \"\$dir/index.tmp\" \"\$dir/index.tsv\"",
            "chmod 600 -- \"\$dir/index.tsv\"",
            "count=\$(wc -l < \"\$dir/index.tsv\")",
            "printf '%s\\t%s\\t%s\\n' $rootQ \"\$count\" \"\$(date +%s)\" > \"\$dir/meta.tsv\"",
            "chmod 600 -- \"\$dir/meta.tsv\"",
            "cat \"\$dir/meta.tsv\""
        ).joinToString("\n")
    }

    fun searchCommand(pattern: String, ignoreCase: Boolean): String {
        require(pattern.isNotBlank() && pattern.length <= 400) { "搜索词1–400字符" }
        require(!pattern.contains('\u0000')) { "搜索词不能包含NUL" }
        val flags = if(ignoreCase) "-F -i" else "-F"
        return listOf(
            "dir=$DIR",
            "test -s \"\$dir/index.tsv\" || exit $NO_SNAPSHOT_EXIT",
            "grep $flags -m $SEARCH_LIMIT -- " + Shell.quote(pattern) + " \"\$dir/index.tsv\""
        ).joinToString("\n")
    }

    data class Meta(val root: String, val entries: Long, val builtAt: Long, val truncated: Boolean)
    /** type(1) \t permOctal(1) \t size \t mtimeSeconds.frac \t path... (path may contain tabs) */
    data class Hit(val path: String, val directory: Boolean, val link: Boolean, val size: Long,
                   val permissions: Int, val modifiedMs: Long, val name: String)

    fun parseMeta(output: String, max: Int): Meta? {
        val line = output.lineSequence().lastOrNull()?.trim() ?: return null
        val parts = line.split('\t')
        if(parts.size < 3) return null
        return Meta(parts[0].trim(), parts[1].trim().toLongOrNull() ?: 0L, parts[2].trim().toLongOrNull() ?: 0L,
            parts[1].trim().toLongOrNull() == max.toLong())
    }

    fun parseHits(output: ExecResult): List<Hit> {
        if(output.code == NO_SNAPSHOT_EXIT) error("尚未建立文件快照，请先建立")
        if(output.code != 0) error("服务器端搜索失败（exit ${output.code}）：${output.output.take(300)}")
        return output.output.lineSequence().filter { it.isNotBlank() }.map { line ->
            val p = line.split('\t', limit = 5)
            if(p.size < 5) null else {
                val type = p[0]
                val perm = p[1].toIntOrNull(8) ?: 0
                val size = p[2].toLongOrNull() ?: 0L
                val mt = p[3].substringBefore('.').toLongOrNull() ?: 0L
                val path = p[4]
                if(path.isEmpty()) null else Hit(path, type == "d", type == "l", size, perm, mt * 1000,
                    path.substringAfterLast('/').ifBlank { path })
            }
        }.filterNotNull().toList().take(SEARCH_LIMIT)
    }
}
