package com.igneous.journeys

import android.app.Activity
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.security.KeyStore
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

@InvokeArg
class SecretArgs {
    var name: String = ""
    var value: String? = null
}

/**
 * The sync token on Android (`secrets.rs` is the Rust half). A key generated inside
 * the Android Keystore never leaves it; the token is sealed with that key (AES-GCM)
 * and the sealed bytes are written to the app's private files, one per remote. An
 * uninstall takes the key with it, and a copied file is useless without it.
 */
@TauriPlugin
class SecretsPlugin(private val activity: Activity) : Plugin(activity) {
    private val alias = "journeys-secrets"
    private val ivBytes = 12
    private val tagBits = 128

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        val spec = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build()
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(spec)
            generateKey()
        }
    }

    /** A remote's address is not a file name, so its hash is. */
    private fun fileFor(name: String): File {
        val hash = MessageDigest.getInstance("SHA-256").digest(name.toByteArray()).joinToString("") { "%02x".format(it) }
        return File(activity.filesDir, "secrets/$hash")
    }

    @Command
    fun set(invoke: Invoke) {
        val args = invoke.parseArgs(SecretArgs::class.java)
        try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
            val sealed = cipher.iv + cipher.doFinal((args.value ?: "").toByteArray())
            fileFor(args.name).apply { parentFile?.mkdirs() }.writeBytes(sealed)
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject("could not seal the token: ${e.message}")
        }
    }

    @Command
    fun get(invoke: Invoke) {
        val args = invoke.parseArgs(SecretArgs::class.java)
        val answer = JSObject()
        val file = fileFor(args.name)
        try {
            if (file.exists()) {
                val sealed = file.readBytes()
                val cipher = Cipher.getInstance("AES/GCM/NoPadding")
                cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(tagBits, sealed.copyOfRange(0, ivBytes)))
                answer.put("value", String(cipher.doFinal(sealed.copyOfRange(ivBytes, sealed.size))))
            }
            invoke.resolve(answer)
        } catch (e: Exception) {
            invoke.reject("could not open the token: ${e.message}")
        }
    }

    @Command
    fun forget(invoke: Invoke) {
        val args = invoke.parseArgs(SecretArgs::class.java)
        fileFor(args.name).delete()
        invoke.resolve()
    }
}
