<script setup lang="ts">
import { reactive, ref } from 'vue'
import { Lock, User } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { api } from '../services/api'

const emit = defineEmits<{ (e: 'logged-in'): void }>()
const form = reactive({ username: '', password: '' })
const loading = ref(false)

async function submit() {
  if (!form.username.trim() || !form.password) return ElMessage.warning('请输入账号和密码')
  loading.value = true
  try {
    await api.auth.login(form.username.trim(), form.password)
    emit('logged-in')
  } catch (error) { ElMessage.error((error as Error).message) }
  finally { loading.value = false }
}
</script>
<template>
  <div class="login-page">
    <div class="login-card">
      <div class="login-brand"><div class="brand-mark">贸</div><div><strong>贸易易</strong><span>外贸业务管理系统</span></div></div>
      <el-form @submit.prevent="submit">
        <el-form-item><el-input v-model="form.username" :prefix-icon="User" placeholder="账号" size="large" autocomplete="username"/></el-form-item>
        <el-form-item><el-input v-model="form.password" :prefix-icon="Lock" type="password" placeholder="密码" size="large" show-password autocomplete="current-password" @keyup.enter="submit"/></el-form-item>
        <el-button type="primary" size="large" class="login-button" :loading="loading" @click="submit">登录</el-button>
      </el-form>
      <p class="login-hint">首次启动时，账号与初始密码打印在服务端控制台</p>
    </div>
  </div>
</template>
<style scoped>
.login-page { display: flex; align-items: center; justify-content: center; min-height: 100vh; background: linear-gradient(135deg, #eef3fb 0%, #dbe6f6 100%); }
.login-card { width: 380px; padding: 40px 36px 28px; background: #fff; border-radius: 14px; box-shadow: 0 18px 50px rgba(30, 50, 90, 0.12); }
.login-brand { display: flex; align-items: center; gap: 12px; margin-bottom: 28px; }
.login-brand .brand-mark { display: flex; align-items: center; justify-content: center; width: 44px; height: 44px; border-radius: 11px; background: #172033; color: #fff; font-size: 20px; font-weight: 600; }
.login-brand strong { display: block; font-size: 17px; color: #172033; }
.login-brand span { font-size: 12px; color: #8a94a6; }
.login-button { width: 100%; margin-top: 4px; }
.login-hint { margin-top: 18px; font-size: 12px; color: #9aa4b2; text-align: center; line-height: 1.5; }
</style>
