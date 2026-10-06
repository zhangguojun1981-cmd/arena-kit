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

private val databaseActions = mapOf("create-database" to "创建数据库", "create-user" to "创建账号", "grant" to "授权", "revoke" to "撤销直接授权", "password" to "修改密码", "backup" to "创建逻辑备份", "restore" to "从备份恢复")

@Composable fun DatabasesPage(vm: DeckViewModel, server: Server) {
    val controller = vm.app.projects
    val all by controller.states.collectAsStateWithLifecycle()
    val state = all[server.id] ?: ProjectState()
    val connected by vm.connected.collectAsStateWithLifecycle()
    val online = server.id in connected
    var sudo by remember(server.id) { mutableStateOf(false) }
    var engine by remember(server.id) { mutableStateOf("postgresql") }
    var user by remember(server.id) { mutableStateOf("postgres") }
    var password by remember(server.id) { mutableStateOf("") }
    var asPostgres by remember(server.id) { mutableStateOf(false) }
    var container by remember(server.id) { mutableStateOf("") }
    var containersOpen by remember(server.id) { mutableStateOf(false) }
    var tab by remember(server.id) { mutableIntStateOf(0) }
    var editor by remember(server.id) { mutableStateOf<String?>(null) }
    var plan by remember(server.id) { mutableStateOf<ProjectPlan?>(null) }
    fun auth() = JSONObject().put("engine",engine).put("user",user).put("password",password).put("asPostgres",asPostgres).put("container",container)
    fun edit(action: String, database: String = "", role: String = "", backup: String = "") {
        editor = JSONObject().put("kind","database").put("auth",auth()).put("operation",action).put("database",database).put("role",role).put("backup",backup).toString()
    }
    LaunchedEffect(server.id,engine,user,password,asPostgres,container,sudo) { controller.clearDatabase(server) }
    Column(Modifier.fillMaxSize().padding(horizontal=16.dp)) {
        SectionTitle("数据库与账号", "独立数据库身份 · 资源列表 · 逻辑备份 · 安全备份后恢复")
        if(!online) { Button(onClick={vm.connect(server)}) { Text("连接服务器") }; return@Column }
        if(state.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
        state.error?.let { Text(it,color=MaterialTheme.colorScheme.error) }
        LazyColumn(Modifier.weight(1f),verticalArrangement=Arrangement.spacedBy(8.dp),contentPadding=PaddingValues(vertical=12.dp)) {
            item {
                Panel {
                    FlowRow(horizontalArrangement=Arrangement.spacedBy(8.dp)) {
                        listOf("postgresql" to "PostgreSQL", "mysql" to "MySQL / MariaDB").forEach { (value,label) ->
                            FilterChip(engine==value,{engine=value;user=if(value=="postgresql") "postgres" else "root";password="";asPostgres=false},enabled=!state.busy,label={Text(label)})
                        }
                    }
                    Text("SSH：${server.endpoint}；以下为另一套数据库认证")
                    Row { Switch(sudo,{sudo=it},enabled=!state.busy); Text("明确使用已有 sudo -n 授权") }
                    OutlinedTextField(user,{user=it},Modifier.fillMaxWidth(),label={Text("数据库管理员账号")},singleLine=true,enabled=!state.busy)
                    OutlinedTextField(password,{password=it},Modifier.fillMaxWidth(),label={Text("数据库管理员密码（可空，仅本次内存）")},visualTransformation=PasswordVisualTransformation(),keyboardOptions=KeyboardOptions(keyboardType=KeyboardType.Password,autoCorrect=false),singleLine=true,enabled=!state.busy)
                    if(engine=="postgresql") Row { Switch(asPostgres,{asPostgres=it},enabled=!state.busy); Text("明确切换到postgres系统用户（peer认证常需要）") }
                    Text(if(container.isEmpty()) "连接位置：原生服务 / 本地socket" else "连接位置：容器 ${container.take(12)} / 本地socket")
                    Row(horizontalArrangement=Arrangement.spacedBy(8.dp)) {
                        TextButton(onClick={container=""},enabled=!state.busy) {Text("原生服务")}
                        TextButton(onClick={controller.loadDatabaseContainers(server,sudo);containersOpen=true},enabled=!state.busy) {Text("选择现有容器")}
                    }
                    Hint("不启用密码登录、不改pg_hba或MySQL主机规则。容器内需要已有数据库客户端。管理账号需有列库/账号及相应管理权限；不自动猜测或提取容器密码。")
                    Button(onClick={controller.loadDatabase(server,auth().toString(),sudo)},enabled=!state.busy) {Text("验证数据库身份并发现资源")}
                }
            }
            state.database?.let { raw ->
                val inventory = JSONObject(raw)
                item { FlowRow(horizontalArrangement=Arrangement.spacedBy(8.dp)) { listOf("数据库","账号","备份").forEachIndexed { i,label -> FilterChip(tab==i,{tab=i},label={Text(label)}) } }
                if(tab==0) {
                    item { OutlinedButton(onClick={edit("create-database")},enabled=!state.busy) {Text("创建数据库") } }
                    items(JobProtocol.rows(inventory,"databases"),key={JSONObject(it).getString("name")}) { value ->
                        val database = JSONObject(value)
                        Panel {
                            Text(database.getString("name"),style=MaterialTheme.typography.titleMedium)
                            Text("所有者：${database.optString("owner").ifEmpty { "按账号授权" }} · 大小：${database.optLong("bytes")} 字节")
                            if(database.optBoolean("protected")) Hint("系统库：只读显示")
                            else {
                                OutlinedButton(onClick={edit("backup",database.getString("name"))},enabled=!state.busy) {Text("备份该数据库")}
                                Hint("恢复入口在备份列表。PostgreSQL备份不含角色/ACL；MySQL单事务备份对非事务表不保证一致性，操作前安排维护窗口。")
                            }
                        }
                    }
                } else if(tab==1) {
                    item { OutlinedButton(onClick={edit("create-user",role="app_")},enabled=!state.busy) {Text("创建普通app_账号") } }
                    items(JobProtocol.rows(inventory,"roles"),key={JSONObject(it).let { r -> r.getString("name")+"@"+r.optString("host") }}) { value ->
                        val role = JSONObject(value)
                        Panel {
                            Text("${role.getString("name")} ${role.optString("host")}",style=MaterialTheme.typography.titleMedium)
                            if(!role.optBoolean("managed")) Hint("系统/管理员/非app_或非localhost账号：只读，避免误改既有身份")
                            else FlowRow(horizontalArrangement=Arrangement.spacedBy(8.dp)) {
                                listOf("grant","revoke","password").forEach { action -> OutlinedButton(onClick={edit(action,role=role.getString("name"))},enabled=!state.busy) {Text(databaseActions.getValue(action))} }
                            }
                        }
                    }
                } else {
                    items(JobProtocol.rows(inventory,"backups"),key={JSONObject(it).getString("id")}) { value ->
                        val backup = JSONObject(value)
                        Panel {
                            Text(backup.getString("database"),style=MaterialTheme.typography.titleMedium)
                            Text("${DateFormat.getDateTimeInstance().format(Date(backup.getLong("created")*1000))} · ${backup.getLong("bytes")} 字节")
                            if(!backup.isNull("recoveryOf")) Text("恢复前安全备份（请保留）")
                            Text("备份源：${backup.optString("container").ifEmpty { "原生服务" }}")
                            Hint("ID：${backup.getString("id")}\nSHA256：${backup.getString("sha256")}")
                            OutlinedButton(onClick={edit("restore",backup.getString("database"),backup=backup.getString("id"))},enabled=!state.busy) {Text("预览恢复到原数据库")}
                            TextButton(onClick={vm.page=2;vm.browse("/var/lib/vpsdeck-private/backups/${backup.getString("id")}")}) {Text("文件页查看 / 下载（需root SSH权限）")}
                        }
                    }
                }
            }
            item { SectionTitle("该主机远端任务"); OutlinedButton(onClick={controller.load(server,sudo,true)},enabled=!state.busy) {Text("查询最新进度")} }
            items(state.jobs,key={JSONObject(it).getString("id")}) { raw ->
                val task=JSONObject(raw)
                Panel {
                    Text("${task.optString("project")} · ${task.optString("action")} · ${JobProtocol.state(task.optString("state"))}")
                    Text(task.optString("message"));Hint("ID：${task.getString("id")}")
                    JobProtocol.rows(task,"resources").forEach { resource -> val r=JSONObject(resource);Text("${r.optString("service")}：${r.optString("state")} ${r.optString("health")}") }
                }
            }
        }
    }
    if(containersOpen) AlertDialog(onDismissRequest={containersOpen=false},title={Text("选择数据库所在容器")},text={Column(Modifier.verticalScroll(rememberScrollState())) {
        if(state.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
        state.databaseContainers.forEach { raw -> val row=JSONObject(raw); TextButton(onClick={container=row.getString("id");containersOpen=false},enabled=!state.busy) {Text("${row.getString("name")} · ${row.getString("image")}")} }
    }},confirmButton={TextButton(onClick={containersOpen=false}) {Text("关闭")}})
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
            Text(JSONObject(p.result).getString("warning"))
            if(p.action=="restore") Text("恢复会修改现有数据！先保留独立可核查的安全备份，不能保证自动回滚；整个任务最长2小时。")
            Text("请求与数据库凭据通过SSH stdin传送，远端任务请求文件仅执行身份可读，完成后删除；被强制中断时可能保留私有请求，需管理员核查。")
            OutlinedTextField(confirmation,{confirmation=it},label={Text("输入目标名称确认：$target")},singleLine=true)
        }},confirmButton={Button(onClick={plan=null;editor=null;controller.submit(server,p,sudo)},enabled=online && !state.busy && confirmation==target) {Text("确认执行")}},dismissButton={TextButton(onClick={plan=null}) {Text("取消")}})
    }
}

@Composable fun DatabaseEditor(seed: String, inventory: String, busy: Boolean, error: String?, close: () -> Unit, preview: (String) -> Unit) {
    val initial=remember(seed) {JSONObject(seed)}
    val operation=initial.getString("operation")
    var database by remember(seed) {mutableStateOf(initial.optString("database"))}
    var role by remember(seed) {mutableStateOf(initial.optString("role"))}
    var password by remember(seed) {mutableStateOf("")}
    var confirmTarget by remember(seed) {mutableStateOf(false)}
    var owner by remember(seed) {mutableStateOf(initial.getJSONObject("auth").getString("user"))}
    FullDialog(databaseActions[operation] ?: operation,{if(!busy) close()}) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)) {
            if(operation !in listOf("create-user","password")) OutlinedTextField(database,{database=it},Modifier.fillMaxWidth(),label={Text("数据库名称")},singleLine=true,enabled=!busy && operation !in listOf("backup","restore"))
            if(operation in listOf("grant","revoke")) FlowRow(horizontalArrangement=Arrangement.spacedBy(6.dp)) { JobProtocol.rows(JSONObject(inventory),"databases").forEach { raw -> val row=JSONObject(raw); if(!row.optBoolean("protected")) FilterChip(database==row.getString("name"),{database=row.getString("name")},enabled=!busy,label={Text(row.getString("name"))}) } }
            if(operation=="create-database" && initial.getJSONObject("auth").getString("engine")=="postgresql") OutlinedTextField(owner,{owner=it},Modifier.fillMaxWidth(),label={Text("已存在的数据库所有者角色")},singleLine=true,enabled=!busy)
            if(operation in listOf("create-user","password","grant","revoke")) OutlinedTextField(role,{role=it},Modifier.fillMaxWidth(),label={Text("app_普通账号名称")},singleLine=true,enabled=!busy && operation=="create-user")
            if(operation in listOf("create-user","password")) OutlinedTextField(password,{password=it},Modifier.fillMaxWidth(),label={Text("新账号密码（12至256字符）")},singleLine=true,visualTransformation=PasswordVisualTransformation(),keyboardOptions=KeyboardOptions(keyboardType=KeyboardType.Password,autoCorrect=false),enabled=!busy)
            if(operation=="restore") {
                Text("备份ID：${initial.getString("backup")}\n仅相同引擎/数据库名。当前目标：${initial.getJSONObject("auth").optString("container").ifEmpty { "原生服务" }}。恢复前必须完成独立安全备份。")
                Row { Checkbox(confirmTarget,{confirmTarget=it},enabled=!busy);Text("我确认当前目标位置；若容器不同，这是跨容器数据恢复，可能覆盖当前数据。") }
            }
            Hint("不提供SQL编辑器。不会自动修改数据库网络监听、认证策略或系统管理员账号。")
            if(busy) LinearProgressIndicator(Modifier.fillMaxWidth())
            error?.let {Text(it,color=MaterialTheme.colorScheme.error)}
            Button(onClick={preview(JSONObject(seed).put("database",database).put("role",role).put("owner",owner).put("newPassword",password).put("confirmRestoreTarget",confirmTarget).put("name",if(operation in listOf("create-user","password")) role else database).toString())},enabled=!busy && (operation!="restore" || confirmTarget)) {Text("预览操作与风险")}
        }
    }
}
