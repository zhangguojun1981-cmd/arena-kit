package dev.vpsdeck.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import org.json.JSONObject
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec


/** No credentials in Room, backups, external storage, logs or saved UI state. */
class SecretStore(context: Context) : CredentialReader {
    private val directory = File(context.noBackupFilesDir, "vault").apply { mkdirs() }
    private val alias = "vpsdeck.credentials.v1"
    @Synchronized private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true).build())
        }.generateKey()
    }
    private fun file(id: String): AtomicFile { require(id.matches(Regex("[a-fA-F0-9-]{36}"))); return AtomicFile(File(directory, id)) }
    fun put(id: String, credentials: Credentials) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()); updateAAD(id.toByteArray()) }
        val raw = JSONObject().put("password", credentials.password).put("privateKey", credentials.privateKey).put("passphrase", credentials.passphrase).toString().toByteArray()
        val encrypted = cipher.doFinal(raw); raw.fill(0)
        val target = file(id); val stream = target.startWrite()
        try { stream.write(byteArrayOf(1)); stream.write(cipher.iv); stream.write(encrypted); target.finishWrite(stream) }
        catch (e: Exception) { target.failWrite(stream); throw e }
    }
    override fun get(id: String): Credentials {
        val target = file(id)
        if (!target.baseFile.exists()) return Credentials()
        val bytes = target.readFully(); require(bytes.size >= 29 && bytes[0].toInt() == 1) { "凭据存储格式无效" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(1, 13))); updateAAD(id.toByteArray()) }
        val raw = cipher.doFinal(bytes.copyOfRange(13, bytes.size))
        return try { val j = JSONObject(String(raw, Charsets.UTF_8)); Credentials(j.optString("password"), j.optString("privateKey"), j.optString("passphrase")) } finally { raw.fill(0) }
    }
    fun delete(id: String) = file(id).delete()
}
