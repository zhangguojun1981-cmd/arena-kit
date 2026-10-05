package dev.vpsdeck.data

data class Credentials(val password: String = "", val privateKey: String = "", val passphrase: String = "")
fun interface CredentialReader { fun get(id: String): Credentials }
