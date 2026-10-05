package dev.vpsdeck.ops

/** Unsupported/missing measurements remain null, never synthetic zero percentages. */
data class Snapshot(
    val sampled: Long, val os: String, val kernel: String, val uptime: String, val load: String,
    val memoryUsedPercent: Float?, val diskUsedPercent: Float?, val cpuTotal: Long?, val cpuIdle: Long?,
    val rxBytes: Long?, val txBytes: Long?, val capabilities: Set<String>, val output: String,
    val cpuPercent: Float? = null, val rxPerSecond: Long? = null, val txPerSecond: Long? = null
)
object Metrics {
    val command = """
        printf 'OS='; if [ -r /etc/os-release ]; then . /etc/os-release; printf '%s\n' "${'$'}PRETTY_NAME"; else uname -s; fi
        printf 'KERNEL='; uname -rm
        printf 'UPTIME='; cut -d ' ' -f 1 /proc/uptime 2>/dev/null || true
        printf 'LOAD='; cut -d ' ' -f 1-3 /proc/loadavg 2>/dev/null || true
        awk '/^cpu / {t=0;for(i=2;i<=9;i++)t+=${'$'}i;printf "CPU=%.0f %.0f\n",t,${'$'}5+${'$'}6}' /proc/stat 2>/dev/null
        awk '/MemTotal:/{t=${'$'}2}/MemAvailable:/{a=${'$'}2;found=1}END{if(t>0 && found)printf "MEM=%.2f\n",100*(t-a)/t}' /proc/meminfo 2>/dev/null
        df -Pk / 2>/dev/null | awk 'NR==2{gsub(/%/,"",${'$'}5);print "DISK="${'$'}5}'
        awk -F'[: ]+' 'NR>2 && ${'$'}2!="lo" {rx+=${'$'}3;tx+=${'$'}11} END{printf "NET=%.0f %.0f\n",rx,tx}' /proc/net/dev 2>/dev/null
        printf 'CAP='; for c in systemctl docker nginx php mysql mariadb psql tmux; do if command -v "${'$'}c" >/dev/null 2>&1; then printf '%s ' "${'$'}c"; fi; done; printf '\n'
    """.trimIndent()
    fun parse(output: String, now: Long, previous: Snapshot? = null): Snapshot {
        val fields = output.lineSequence().filter { it.contains('=') }.associate { it.substringBefore('=') to it.substringAfter('=').trim() }
        fun numbers(key: String) = fields[key]?.split(Regex("\\s+"))?.mapNotNull { it.toLongOrNull() }.orEmpty()
        val cpu = numbers("CPU"); val net = numbers("NET")
        val total = cpu.getOrNull(0); val idle = cpu.getOrNull(1)
        val dt = previous?.let { (now - it.sampled) / 1000.0 } ?: 0.0
        val delta = if(total != null && previous?.cpuTotal != null) total - previous.cpuTotal else 0
        val cpuPercent = if(delta > 0 && idle != null && previous?.cpuIdle != null) (100.0 * (delta - (idle - previous.cpuIdle)) / delta).toFloat().coerceIn(0f, 100f) else null
        fun rate(index: Int, old: Long?): Long? = if(dt > 0 && old != null && net.getOrNull(index) != null && net[index] >= old) ((net[index] - old) / dt).toLong() else null
        return Snapshot(now, fields["OS"].orEmpty(), fields["KERNEL"].orEmpty(), fields["UPTIME"].orEmpty(), fields["LOAD"].orEmpty(),
            fields["MEM"]?.toFloatOrNull()?.coerceIn(0f, 100f), fields["DISK"]?.toFloatOrNull()?.coerceIn(0f, 100f), total, idle,
            net.getOrNull(0), net.getOrNull(1), fields["CAP"].orEmpty().split(' ').filter { it.isNotBlank() }.toSet(), output, cpuPercent, rate(0, previous?.rxBytes), rate(1, previous?.txBytes))
    }
}
