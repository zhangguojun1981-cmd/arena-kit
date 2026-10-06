@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
package dev.vpsdeck.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.vpsdeck.DeckViewModel
import dev.vpsdeck.data.Server
import dev.vpsdeck.panel.*
import org.json.JSONObject

@Composable fun WebsitesPage(vm: DeckViewModel, server: Server) {
    val controller = vm.app.websites
    val all by controller.states.collectAsStateWithLifecycle()
    val state = all[server.id] ?: WebsiteState()
    val connections by vm.connected.collectAsStateWithLifecycle()
    val online = server.id in connections
    var sudo by remember(server.id) { mutableStateOf(false) }
    var query by remember(server.id) { mutableStateOf("") }
    var selected by remember(server.id) { mutableStateOf<String?>(null) }
    var editor by remember(server.id) { mutableStateOf<Pair<String,String>?>(null) }
    var plan by remember(server.id) { mutableStateOf<WebsitePlan?>(null) }
    var recover by remember(server.id) { mutableStateOf<Website?>(null) }
    var certRequest by remember(server.id) { mutableStateOf<Website?>(null) }
    var renewal by remember(server.id) { mutableStateOf<Website?>(null) }
    var restore by remember(server.id) { mutableStateOf<Pair<Website,String>?>(null) }
    val busy = state.busy != null
    val row = state.rows.find { it.id == selected }
    LaunchedEffect(server.id,online) { if(online) controller.load(server,sudo) }
    Column(Modifier.fillMaxSize().padding(horizontal=16.dp)) {
        ManagementHeading("网站管理", "表单建站 · 配置差异 · 校验发布 · 备份恢复")
        if(!online) { Text("请先连接服务器"); Button(onClick={vm.connect(server)}) { ActionLabel("连接") }; return@Column }
        LazyColumn(Modifier.weight(1f),verticalArrangement=Arrangement.spacedBy(12.dp),contentPadding=PaddingValues(vertical=12.dp)) {
            item { Panel {
                PrivilegeControl(sudo,enabled=!busy && editor==null && plan==null) {sudo=it}
                ActionGroup {
                    ActionGroup {
                        Button(onClick={editor=WebsiteProtocol.fresh() to ""},enabled=!busy) { ActionLabel("新建网站") }
                        OutlinedButton(onClick={controller.load(server,sudo)},enabled=!busy) { ActionLabel("刷新") }
                    }
                }
                OutlinedTextField(query,{query=it},Modifier.fillMaxWidth(),singleLine=true,label={Text("搜索域名")})
                if(busy) { LinearProgressIndicator(Modifier.fillMaxWidth()); Text(state.busy.orEmpty()) }
                state.error?.let { CopyableOutput(it,"错误详情",error=true) }
                state.notice?.let { CopyableOutput(it,"操作结果") }
            } }
            if(state.loaded && state.rows.isEmpty()) item { Panel { Text("暂无App管理的网站"); Hint("已有Nginx配置在下方单列，不自动接管或重写。") } }
            if(state.loaded && state.rows.isNotEmpty() && state.rows.none {it.domain.contains(query,true)}) item {Panel {Hint("没有匹配的网站")}}
            items(state.rows.filter { it.domain.contains(query,true) },key={it.id}) { site ->
                Panel(Modifier.clickable(enabled=!busy) { selected=site.id; controller.clearBackups(server) }) {
                    ResourceHeading(site.domain,if(site.enabled) "启用" else "停用","${site.json.getString("kind")} · 端口 ${site.json.getInt("port")}")
                    Text(if(site.json.optBoolean("tls")) "HTTPS（已有证书）" else "HTTP")
                    if(site.drift) Text("外部配置发生变化，禁止覆盖",color=MaterialTheme.colorScheme.error)
                    if(site.pending) Text("上次变更未完成，需恢复/核查",color=MaterialTheme.colorScheme.error)
                    OutlinedButton(onClick={selected=site.id;controller.clearBackups(server)},enabled=!busy) {ActionLabel("管理网站")}
                }
            }
            item { SectionTitle("现有非托管配置", "只读发现；复杂include与自定义规则不会转成表单或被覆盖") }
            items(state.unmanaged) { path ->
                Panel {Hint(path);OutlinedButton(onClick={vm.page=2;vm.browse(path.substringBeforeLast('/'))},enabled=!busy) {ActionLabel("打开配置目录")}}
            }
            item { Hint("需要原生Nginx与Python3。未安装时明确失败，不自动安装。签发需要已有certbot、正确公网DNS与80端口；启用续期timer另行确认。") }
        }
    }
    row?.let { site -> FullDialog(site.domain,{if(!busy) selected=null}) { padding ->
        Column(Modifier.padding(padding).padding(16.dp).verticalScroll(rememberScrollState()),verticalArrangement=Arrangement.spacedBy(12.dp)) {
            Hint("目标：${server.name} · ${server.endpoint}")
            SectionTitle(if(site.enabled) "网站配置已启用" else "网站已停用")
            Text("类型：${site.json.getString("kind")}\n端口：${site.json.getInt("port")}\n目录：${site.json.getString("root")}")
            if(site.json.getString("kind")=="proxy") Text("反代：${site.json.optString("upstream")}")
            if(site.pending) Text("有未完成事务。恢复会重载Nginx，将配置回到上次操作之前。",color=MaterialTheme.colorScheme.error)
            if(site.drift) Text("检测到配置被外部修改，先在文件管理中核查；不允许表单覆盖。",color=MaterialTheme.colorScheme.error)
            state.error?.let { CopyableOutput(it,"错误详情",error=true) }; state.notice?.let { CopyableOutput(it,"操作结果") }
            if(busy) { LinearProgressIndicator(Modifier.fillMaxWidth()); Text(state.busy.orEmpty()) }
            ActionGroup {
                Button(onClick={editor=site.spec to site.revision},enabled=!busy && !site.drift && !site.pending && online) { ActionLabel("编辑网站") }
                OutlinedButton(onClick={controller.preview(server,site.json.put("enabled",!site.enabled).toString(),site.revision,false,sudo) {plan=it}},enabled=!busy && !site.drift && !site.pending && online) { ActionLabel(if(site.enabled) "停用网站" else "启用网站") }
            }
            if(site.pending) OutlinedButton(onClick={recover=site},enabled=!busy && online) { ActionLabel("恢复上次未完成操作") }
            ActionGroup {
                OutlinedButton(onClick={selected=null; vm.page=2; vm.browse(site.json.getString("root"))},enabled=!busy) { ActionLabel("管理网站文件") }
                OutlinedButton(onClick={controller.health(server,site,sudo)},enabled=!busy && online && site.enabled) { ActionLabel("检查 HTTP 响应") }
            }
            HorizontalDivider(); SectionTitle("HTTPS与证书", "自动签发使用Let's Encrypt HTTP80验证；需已有certbot，不自动安装或修改DNS/防火墙。")
            ActionGroup {
                OutlinedButton(onClick={certRequest=site},enabled=!busy && online && site.enabled) {ActionLabel("申请 / 更新证书")}
                OutlinedButton(onClick={controller.certificate(server,site,sudo) {editor=it to site.revision}},enabled=!busy && online) {ActionLabel("配置 HTTPS")}
                OutlinedButton(onClick={renewal=site},enabled=!busy && online && site.enabled) {ActionLabel("启用自动续期")}
            }
            HorizontalDivider(); SectionTitle("配置备份", "只恢复Nginx配置，不回滚网站文件或数据库。首次创建前的空备份不可用此入口恢复。")
            OutlinedButton(onClick={controller.backups(server,site,sudo)},enabled=!busy && online) { ActionLabel("读取配置备份") }
            state.backups.forEach { backup -> Panel {Hint(backup);TextButton(onClick={restore=site to backup},enabled=!busy && !site.pending && !site.drift && online) {ActionLabel("恢复此备份")}} }
        }
    } }
    editor?.let { (spec,expected) -> WebsiteEditor(spec,state.sockets,busy,state.error,{if(!busy) editor=null}) { newSpec,create ->
        controller.preview(server,newSpec,expected,create,sudo) { plan=it }
    } }
    plan?.let { p -> AlertDialog(onDismissRequest={if(!busy) plan=null},title={Text("校验并发布网站配置？")},text={
        Column(Modifier.verticalScroll(rememberScrollState())) {
            Text("目标：${server.name}\n${server.endpoint}\n域名：${JSONObject(p.spec).getString("domain")}\n\n将备份原配置、检查Nginx语法、重载Nginx。停用可能中断网站访问；不删除站点文件。${if(p.createRoot) "\n允许创建不存在的站点目录及欢迎页，不覆盖已有文件。" else ""}${if(sudo) "\n使用sudo -n。" else ""}")
            CopyableOutput(p.diff.ifBlank {"生成配置没有差异，仍会进行校验与重载。"},"配置差异")
            Text("配置发布不等于HTTP业务健康通过。若连接中断请先刷新核查，不重复提交。")
            state.error?.let { CopyableOutput(it,"错误详情",error=true) }
        }
    },confirmButton={Button(onClick={controller.apply(server,p,sudo) {plan=null;editor=null}},enabled=!busy && online) {ActionLabel("备份、校验并发布")}},dismissButton={TextButton(onClick={plan=null},enabled=!busy) {ActionLabel("取消")}}) }
    certRequest?.let { r ->
        var email by remember(r.id) {mutableStateOf("")}; var agree by remember(r.id) {mutableStateOf(false)}
        AlertDialog(onDismissRequest={certRequest=null},title={Text("申请网站证书？")},text={Column(Modifier.verticalScroll(rememberScrollState())) {
            Text("${server.name}\n${r.domain}\n需要你拥有并正确解析此域名，公网80端口可达。此操作联系Let's Encrypt，不会更改DNS/防火墙。失败或断线后先查询证书，不反复申请以免触发限额。")
            OutlinedTextField(email,{email=it},label={Text("联系邮箱")},singleLine=true)
            Row {Checkbox(agree,{agree=it});Text("我有权管理该域名，并同意Let's Encrypt服务条款（letsencrypt.org/repository/）")}
        }},confirmButton={Button(onClick={certRequest=null;controller.issue(server,r,email.trim(),sudo) { }},enabled=agree && email.contains('@') && !busy && online) {ActionLabel("申请证书")}},dismissButton={TextButton(onClick={certRequest=null}) {ActionLabel("取消")}})
    }
    renewal?.let { r -> AlertDialog(onDismissRequest={renewal=null},title={Text("启用系统续期timer？")},text={Text("${server.name}\n将启用已有的certbot.timer；它会按certbot现有配置检查续期，不只限于此站点。需要保留公网80端口验证入口。同时创建仅作用于App命名证书的续期deploy hook：成功续期后执行nginx配置检查，再重载Nginx。不会覆盖已有不同内容的hook，不自动安装certbot或改动其他timer；不等于实际续期已验收。")},confirmButton={Button(onClick={renewal=null;controller.renewal(server,r,sudo)},enabled=!busy && online) {ActionLabel("确认启用")}},dismissButton={TextButton(onClick={renewal=null}) {ActionLabel("取消")}}) }
    recover?.let { r -> AlertDialog(onDismissRequest={recover=null},title={Text("恢复未完成网站操作？")},text={Text("${server.name}\n${r.domain}\n恢复原配置并重载Nginx，不删除目录。如出现外部修改会拒绝恢复。")},confirmButton={Button(onClick={recover=null;controller.recover(server,r,sudo)},enabled=!busy && online) {ActionLabel("确认恢复")}},dismissButton={TextButton(onClick={recover=null}) {ActionLabel("取消")}}) }
    restore?.let { (r,b) -> AlertDialog(onDismissRequest={restore=null},title={Text("恢复网站配置备份？")},text={Text("${server.name}\n${r.domain}\n$b\n\n当前配置先备份；校验后重载Nginx，网站行为可能变化。")},confirmButton={Button(onClick={restore=null;controller.restore(server,r,b,sudo) { }},enabled=!busy && online) {ActionLabel("确认恢复")}},dismissButton={TextButton(onClick={restore=null}) {ActionLabel("取消")}}) }
}

@Composable internal fun WebsiteEditor(seed: String,sockets: List<String>,busy: Boolean,error: String?,close: () -> Unit,preview: (String,Boolean) -> Unit) {
    val original = remember(seed) {JSONObject(seed)}
    var domain by remember(seed) {mutableStateOf(original.optString("domain"))}
    var kind by remember(seed) {mutableStateOf(original.optString("kind","static"))}
    var port by remember(seed) {mutableStateOf(original.optInt("port",80).toString())}
    var root by remember(seed) {mutableStateOf(original.optString("root"))}
    var upstream by remember(seed) {mutableStateOf(original.optString("upstream"))}
    var socket by remember(seed) {mutableStateOf(original.optString("phpSocket"))}
    var tls by remember(seed) {mutableStateOf(original.optBoolean("tls"))}
    var cert by remember(seed) {mutableStateOf(original.optString("cert"))}
    var key by remember(seed) {mutableStateOf(original.optString("key"))}
    var create by remember(seed) {mutableStateOf(false)}
    FullDialog("网站配置",close) { padding ->
        Column(Modifier.padding(padding).padding(16.dp).verticalScroll(rememberScrollState()),verticalArrangement=Arrangement.spacedBy(12.dp)) {
            Text("先填写表单，再预览差异。不会直接覆盖已有非托管站点。")
            OutlinedTextField(domain,{domain=it},Modifier.fillMaxWidth(),enabled=!busy,singleLine=true,label={Text("域名（ASCII，不含协议）")})
            ActionGroup { listOf("static" to "静态网站","proxy" to "反向代理","php" to "PHP网站").forEach { (value,label) -> FilterChip(kind==value,{kind=value},enabled=!busy,label={ActionLabel(label)}) } }
            OutlinedTextField(port,{port=it.filter(Char::isDigit)},Modifier.fillMaxWidth(),enabled=!busy,singleLine=true,label={Text("监听端口")})
            OutlinedTextField(root,{root=it},Modifier.fillMaxWidth(),enabled=!busy,singleLine=true,label={Text("站点目录（/var/www/ 下）")})
            Row {Checkbox(create,{create=it},enabled=!busy);Text("允许创建不存在的站点目录和欢迎页（不覆盖现有文件）")}
            if(kind=="proxy") OutlinedTextField(upstream,{upstream=it},Modifier.fillMaxWidth(),enabled=!busy,singleLine=true,label={Text("反代目标，例如 http://127.0.0.1:3000")})
            if(kind=="php") {
                SectionTitle("PHP-FPM")
                if(sockets.isEmpty()) Hint("没有发现运行中的PHP-FPM套接字，发布会检查是否可用，不自动安装。")
                sockets.forEach { value -> Panel {Hint(value);TextButton(onClick={socket=value},enabled=!busy) {ActionLabel("使用此路径")}} }
                OutlinedTextField(socket,{socket=it},Modifier.fillMaxWidth(),enabled=!busy,label={Text("PHP-FPM套接字路径")})
            }
            Row {Switch(tls,{tls=it;if(it && port=="80") port="443" else if(!it && port=="443") port="80"},enabled=!busy);Text("HTTPS：使用服务器上已有证书")}
            if(tls) {
                Hint("仅填写服务器路径，不上传或显示证书私钥。也可先创建HTTP80站点，再到详情申请专用证书。")
                OutlinedTextField(cert,{cert=it},Modifier.fillMaxWidth(),enabled=!busy,label={Text("fullchain.pem 服务器绝对路径")})
                OutlinedTextField(key,{key=it},Modifier.fillMaxWidth(),enabled=!busy,label={Text("privkey.pem 服务器绝对路径")})
            }
            error?.let { CopyableOutput(it,"错误详情",error=true) }
            if(busy) LinearProgressIndicator(Modifier.fillMaxWidth())
            Button(onClick={preview(JSONObject(seed).put("domain",domain.trim()).put("kind",kind).put("port",port.toIntOrNull() ?: 0).put("root",root.trim()).put("upstream",upstream.trim()).put("phpSocket",socket.trim()).put("tls",tls).put("cert",cert.trim()).put("key",key.trim()).toString(),create)},enabled=!busy && domain.isNotBlank(),modifier=Modifier.fillMaxWidth()) {ActionLabel("预览配置差异")}
        }
    }
}
