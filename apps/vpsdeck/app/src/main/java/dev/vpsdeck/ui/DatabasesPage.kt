@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
package dev.vpsdeck.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.vpsdeck.DeckViewModel
import dev.vpsdeck.data.Server
import dev.vpsdeck.panel.*
import org.json.JSONObject
import java.text.DateFormat
import java.util.Date

private val databaseActions = mapOf("create-database" to "创建数据库", "create-user" to "创建账号", "grant" to "授权", "revoke" to "撤销直接授权", "password" to "修改密码", "backup" to "创建逻辑备份", "restore" to "从备份恢复", "drop-database" to "备份后删除数据库", "drop-user" to "删除普通账号")

@Composable fun DatabasesPage(vm: DeckViewModel, server: Server) {
    val controller = vm.app.projects
    val all by controller.states.collectAsStateWithLifecycle()
    val state = all[server.id] ?: ProjectState()
    val connected by vm.connected.collectAsStateWithLifecycle()
    val online = server.id in connected
    var identityExpanded by remember(server.id) {mutableStateOf(true)}
    LaunchedEffect(state.database!=null) {if(state.database!=null) identityExpanded=false}
    var sudo by remember(server.id) { mutableStateOf(false) }
    var engine by remember(server.id) { mutableStateOf("postgresql") }
    var user by remember(server.id) { mutableStateOf("postgres") }
    var password by remember(server.id) { mutableStateOf("") }
    var asPostgres by remember(server.id) { mutableStateOf(false) }
    var container by remember(server.id) { mutableStateOf("") }
    var containersOpen by remember(server.id) { mutableStateOf(false) }
    var tab by remember(server.id) { mutableIntStateOf(0) }
    var resourceQuery by remember(server.id,tab) {mutableStateOf("")}
    var editor by remember(server.id) { mutableStateOf<String?>(null) }
    var plan by remember(server.id) { mutableStateOf<ProjectPlan?>(null) }
    fun auth() = JSONObject().put("engine",engine).put("user",user).put("password",password).put("asPostgres",asPostgres).put("container",container)
    fun edit(action: String, database: String = "", role: String = "", backup: String = "") {
        editor = JSONObject().put("kind","database").put("auth",auth()).put("operation",action).put("database",database).put("role",role).put("backup",backup).toString()
    }
    RemoteTaskRefresh(vm,server,sudo) {if(state.database!=null) controller.loadDatabase(server,auth().toString(),sudo)}
    LaunchedEffect(server.id,engine,user,password,asPostgres,container,sudo) { controller.clearDatabase(server) }
    Column(Modifier.fillMaxSize().padding(horizontal=16.dp)) {
        ManagementHeading("数据库与账号", "独立数据库身份 · 资源列表 · 逻辑备份 · 安全备份后恢复")
        if(!online) { Button(onClick={vm.connect(server)}) { ActionLabel("连接服务器") }; return@Column }
        LazyColumn(Modifier.weight(1f),verticalArrangement=Arrangement.spacedBy(12.dp),contentPadding=PaddingValues(vertical=12.dp)) {
            item { Panel {
                if(state.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
                state.error?.let { CopyableOutput(it,"错误详情",error=true) }
            } }
            item {
                Panel {
                    Column(verticalArrangement=Arrangement.spacedBy(4.dp)) {
                        SectionTitle("数据库连接",if(state.database!=null) "$engine · $user" else "数据库身份独立于 SSH")
                        TextButton(onClick={identityExpanded=!identityExpanded},enabled=!state.busy) {ActionLabel(if(identityExpanded) "收起" else "编辑身份")}
                    }
                    if(identityExpanded || state.database==null) Column(verticalArrangement=Arrangement.spacedBy(10.dp)) {
                    ActionGroup {
                        listOf("postgresql" to "PostgreSQL", "mysql" to "MySQL / MariaDB").forEach { (value,label) ->
                            FilterChip(engine==value,{engine=value;user=if(value=="postgresql") "postgres" else "root";password="";asPostgres=false},enabled=!state.busy,label={ActionLabel(label)})
                        }
                    }
                    Text("SSH：${server.endpoint}；以下为另一套数据库认证")
                    PrivilegeControl(sudo,enabled=!state.busy) {sudo=it}
                    OutlinedTextField(user,{user=it},Modifier.fillMaxWidth(),label={Text("数据库管理员账号")},singleLine=true,enabled=!state.busy)
                    OutlinedTextField(password,{password=it},Modifier.fillMaxWidth(),label={Text("数据库管理员密码（可空，仅本次内存）")},visualTransformation=PasswordVisualTransformation(),keyboardOptions=KeyboardOptions(keyboardType=KeyboardType.Password,autoCorrect=false),singleLine=true,enabled=!state.busy)
                    if(engine=="postgresql") Row { Switch(asPostgres,{asPostgres=it},enabled=!state.busy); Text("明确切换到postgres系统用户（peer认证常需要）") }
                    Text(if(container.isEmpty()) "连接位置：原生服务 / 本地socket" else "连接位置：容器 ${container.take(12)} / 本地socket")
                    ActionGroup {
                        TextButton(onClick={container=""},enabled=!state.busy) {ActionLabel("原生服务")}
                        TextButton(onClick={controller.loadDatabaseContainers(server,sudo);containersOpen=true},enabled=!state.busy) {ActionLabel("选择现有容器")}
                    }
                    Hint("不启用密码登录、不改pg_hba或MySQL主机规则。容器内需要已有数据库客户端。管理账号需有列库/账号及相应管理权限；不自动猜测或提取容器密码。")
                    Button(onClick={controller.loadDatabase(server,auth().toString(),sudo)},enabled=!state.busy) {ActionLabel("验证并加载")}
                    }
                }
            }
            state.database?.let { raw ->
                val inventory = JSONObject(raw)
                item { ActionGroup { listOf("数据库","账号","备份").forEachIndexed { i,label -> FilterChip(tab==i,{tab=i},label={ActionLabel(label)}) } } }
                item {OutlinedTextField(resourceQuery,{resourceQuery=it},Modifier.fillMaxWidth(),singleLine=true,label={Text("搜索当前资源")})}
                val resourceKey=if(tab==0) "databases" else if(tab==1) "roles" else "backups"
                val visible=JobProtocol.rows(inventory,resourceKey).filter { val r=JSONObject(it);(r.optString("name")+r.optString("database")+r.optString("id")).contains(resourceQuery,true) }
                item {Hint("${visible.size} 条资源")}
                if(visible.isEmpty()) item {Panel {Hint("当前没有匹配资源")}}
                if(tab==0) {
                    item { OutlinedButton(onClick={edit("create-database")},enabled=!state.busy) {ActionLabel("创建数据库") } }
                    items(visible,key={JSONObject(it).getString("name")}) { value ->
                        val database = JSONObject(value)
                        Panel {
                            Text(database.getString("name"),style=MaterialTheme.typography.titleMedium)
                            DetailRow("所有者",database.optString("owner").ifEmpty {"按账号授权"})
                            DetailRow("占用空间",bytes(database.optLong("bytes")))
                            Text("字符集：${database.optString("charset").ifEmpty { "未返回" }} · ${database.optString("collation")}")
                            if(database.optBoolean("protected")) Hint("系统库：只读显示")
                            else {
                                ActionGroup {
                                    OutlinedButton(onClick={edit("backup",database.getString("name"))},enabled=!state.busy) {ActionLabel("备份该数据库")}
                                    OutlinedButton(onClick={edit("drop-database",database.getString("name"))},enabled=!state.busy) {ActionLabel("备份后删除数据库",color=MaterialTheme.colorScheme.error)}
                                }
                                Hint("恢复入口在备份列表。PostgreSQL备份不含角色/ACL；MySQL单事务备份对非事务表不保证一致性，操作前安排维护窗口。")
                            }
                        }
                    }
                } else if(tab==1) {
                    item { OutlinedButton(onClick={edit("create-user",role="app_")},enabled=!state.busy) {ActionLabel("创建应用账号") } }
                    items(visible,key={JSONObject(it).let { r -> r.getString("name")+"@"+r.optString("host") }}) { value ->
                        val role = JSONObject(value)
                        Panel {
                            Text("${role.getString("name")} ${role.optString("host")}",style=MaterialTheme.typography.titleMedium)
                            if(!role.optBoolean("managed")) Hint("系统/管理员/非app_或非localhost账号：只读，避免误改既有身份")
                            else ActionGroup {
                                listOf("grant","revoke","password","drop-user").forEach { action -> OutlinedButton(onClick={edit(action,role=role.getString("name"))},enabled=!state.busy) {ActionLabel(databaseActions.getValue(action))} }
                            }
                        }
                    }
                } else {
                    items(visible,key={JSONObject(it).getString("id")}) { value ->
                        val backup = JSONObject(value)
                        Panel {
                            Text(backup.getString("database"),style=MaterialTheme.typography.titleMedium)
                            Text("${DateFormat.getDateTimeInstance().format(Date(backup.getLong("created")*1000))} · ${backup.getLong("bytes")} 字节")
                            if(!backup.isNull("recoveryOf")) Text("高风险操作前安全备份（请保留）")
                            Text("备份源：${backup.optString("container").ifEmpty { "原生服务" }}")
                            CopyableOutput("ID：${backup.getString("id")}\nSHA256：${backup.getString("sha256")}","备份校验信息")
                            Hint("查看或下载远端私有备份需要对应SSH权限。")
                            OutlinedButton(onClick={edit("restore",backup.getString("database"),backup=backup.getString("id"))},enabled=!state.busy) {ActionLabel("预览恢复到原数据库")}
                            TextButton(onClick={vm.page=2;vm.browse("/var/lib/vpsdeck-private/backups/${backup.getString("id")}")}) {ActionLabel("查看备份文件")}
                        }
                    }
                }
            }
            item { SectionTitle("该主机远端任务"); OutlinedButton(onClick={controller.load(server,sudo,true)},enabled=!state.busy) {ActionLabel("查询最新进度")} }
            items(state.jobs,key={JSONObject(it).getString("id")}) {raw -> RemoteJobCard(raw)}
        }
    }
    if(containersOpen) AlertDialog(onDismissRequest={containersOpen=false},title={Text("选择数据库所在容器")},text={Column(Modifier.verticalScroll(rememberScrollState())) {
        if(state.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
        state.databaseContainers.forEach { raw -> val row=JSONObject(raw); Panel {Text(row.getString("name"));Hint(row.getString("image"));TextButton(onClick={container=row.getString("id");containersOpen=false},enabled=!state.busy) {ActionLabel("选择容器")}} }
    }},confirmButton={TextButton(onClick={containersOpen=false}) {ActionLabel("关闭")}})
    editor?.let { seed -> DatabaseEditor(seed,state.database ?: "{}",state.busy,state.error,{editor=null}) { spec ->
        controller.preview(server,spec,JSONObject(spec).getString("operation"),sudo) {plan=it}
    } }
    plan?.let { p ->
        val spec=JSONObject(p.project)
        var confirmation by remember(p) { mutableStateOf("") }
        val target=spec.getString("name")
        AlertDialog(onDismissRequest={plan=null},title={Text(databaseActions[p.action] ?: p.action)},text={Column(Modifier.verticalScroll(rememberScrollState()),verticalArrangement=Arrangement.spacedBy(8.dp)) {
            Text("${server.name} · ${server.endpoint}\n目标：$target")
            Text("数据库身份：${spec.getJSONObject("auth").getString("user")} · ${spec.getJSONObject("auth").getString("engine")}")
            Text("目标数据库：${spec.optString("database")} · 目标账号：${spec.optString("role")}\n连接位置：${spec.getJSONObject("auth").optString("container").ifEmpty { "原生socket" }}")
            if(p.action=="create-database") Text("数据库所有者：${spec.optString("owner")}")
            CopyButton(previewReport(JSONObject(p.result)),"复制预览结果")
            Text(JSONObject(p.result).getString("warning"))
            if(p.action=="restore") Text("恢复会修改现有数据！先保留独立可核查的安全备份，不能保证自动回滚；整个任务最长2小时。")
            Text("请求与数据库凭据通过SSH stdin传送，远端敏感输入与任务记录分离，仅执行身份可读，执行器读取后删除；启动前中断可能保留私有输入，需管理员核查。")
            OutlinedTextField(confirmation,{confirmation=it},label={Text("输入目标名称确认：$target")},singleLine=true)
        }},confirmButton={Button(onClick={plan=null;editor=null;controller.submit(server,p,sudo)},enabled=online && !state.busy && confirmation==target) {ActionLabel("确认执行")}},dismissButton={TextButton(onClick={plan=null}) {ActionLabel("取消")}})
    }
}

@Composable fun DatabaseEditor(seed: String, inventory: String, busy: Boolean, error: String?, close: () -> Unit, preview: (String) -> Unit) {
    val initial=remember(seed) {JSONObject(seed)}
    val operation=initial.getString("operation")
    var database by remember(seed) {mutableStateOf(initial.optString("database"))}
    var role by remember(seed) {mutableStateOf(initial.optString("role"))}
    var password by remember(seed) {mutableStateOf("")}
    var confirmTarget by remember(seed) {mutableStateOf(false)}
    var charset by remember(seed) {mutableStateOf("")}
    var owner by remember(seed) {mutableStateOf(initial.getJSONObject("auth").getString("user"))}
    FullDialog(databaseActions[operation] ?: operation,{if(!busy) close()}) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)) {
            if(operation !in listOf("create-user","password","drop-user")) OutlinedTextField(database,{database=it},Modifier.fillMaxWidth(),label={Text("数据库名称")},singleLine=true,enabled=!busy && operation !in listOf("backup","restore","drop-database"))
            if(operation in listOf("grant","revoke")) FlowRow(horizontalArrangement=Arrangement.spacedBy(6.dp)) { JobProtocol.rows(JSONObject(inventory),"databases").forEach { raw -> val row=JSONObject(raw); if(!row.optBoolean("protected")) FilterChip(database==row.getString("name"),{database=row.getString("name")},enabled=!busy,label={ActionLabel(row.getString("name"))}) } }
            if(operation=="create-database") Row { Checkbox(charset.isNotEmpty(),{charset=if(it) {if(initial.getJSONObject("auth").getString("engine")=="postgresql") "UTF8" else "utf8mb4"} else ""},enabled=!busy);Text("明确使用UTF8/utf8mb4；未勾选时使用服务器默认") }
            if(operation=="create-database" && initial.getJSONObject("auth").getString("engine")=="postgresql") OutlinedTextField(owner,{owner=it},Modifier.fillMaxWidth(),label={Text("已存在的数据库所有者角色")},singleLine=true,enabled=!busy)
            if(operation in listOf("create-user","password","grant","revoke","drop-user")) OutlinedTextField(role,{role=it},Modifier.fillMaxWidth(),label={Text("app_普通账号名称")},singleLine=true,enabled=!busy && operation=="create-user")
            if(operation in listOf("create-user","password")) OutlinedTextField(password,{password=it},Modifier.fillMaxWidth(),label={Text("新账号密码（12至256字符）")},singleLine=true,visualTransformation=PasswordVisualTransformation(),keyboardOptions=KeyboardOptions(keyboardType=KeyboardType.Password,autoCorrect=false),enabled=!busy)
            if(operation=="restore") {
                Text("备份ID：${initial.getString("backup")}\n仅相同引擎/数据库名。当前目标：${initial.getJSONObject("auth").optString("container").ifEmpty { "原生服务" }}。恢复前必须完成独立安全备份。")
                Row { Checkbox(confirmTarget,{confirmTarget=it},enabled=!busy);Text("我确认当前目标位置；若容器不同，这是跨容器数据恢复，可能覆盖当前数据。") }
            }
            Hint("不提供SQL编辑器。不会自动修改数据库网络监听、认证策略或系统管理员账号。")
            if(busy) LinearProgressIndicator(Modifier.fillMaxWidth())
            error?.let { CopyableOutput(it,"错误详情",error=true) }
            Button(onClick={preview(JSONObject(seed).put("database",database).put("role",role).put("owner",owner).put("charset",charset).put("newPassword",password).put("confirmRestoreTarget",confirmTarget).put("name",if(operation in listOf("create-user","password","drop-user")) role else database).toString())},enabled=!busy && (operation!="restore" || confirmTarget)) {ActionLabel("预览操作与风险")}
        }
    }
}
