<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Box, Clock, Collection, Document, Files, Fold, Help, House, Menu as MenuIcon, Setting, Shop, Tickets, User, UserFilled } from '@element-plus/icons-vue'
import ProductLibrary from './views/ProductLibrary.vue'
import SupplierLibrary from './views/SupplierLibrary.vue'
import CustomerLibrary from './views/CustomerLibrary.vue'
import CustomerFollowUp from './views/CustomerFollowUp.vue'
import QuoteManagement from './views/QuoteManagement.vue'
import DocumentCenter from './views/DocumentCenter.vue'
import MyCompany from './views/MyCompany.vue'
import DocumentTemplates from './views/DocumentTemplates.vue'
import DocumentGenerate from './views/DocumentGenerate.vue'
import LoginPage from './views/LoginPage.vue'
import { AUTH_EXPIRED_EVENT, api } from './services/api'

// 登录门禁：未确认身份前不渲染任何业务页面，避免先闪一下再跳走
const authReady = ref(false)
const currentUser = ref<{ username: string; displayName: string } | null>(null)

async function checkAuth() {
  try { const data = await api.auth.me(); currentUser.value = data.user }
  catch { currentUser.value = null }
  finally { authReady.value = true }
}
function onLoggedIn() { checkAuth() }
// 任意接口返回 401 都回到登录页，并提示原因
function onAuthExpired() {
  if (!currentUser.value) return
  currentUser.value = null
  ElMessage.warning('登录已过期，请重新登录')
}
async function logout() {
  try { await api.auth.logout() } catch { /* 登出失败也要让本地状态归零 */ }
  currentUser.value = null
}
onMounted(() => {
  checkAuth()
  window.addEventListener(AUTH_EXPIRED_EVENT, onAuthExpired)
})

type ModuleKey = 'dashboard' | 'products' | 'suppliers' | 'customers' | 'followup' | 'quotes' | 'documents' | 'company' | 'templates' | 'generate'
interface NavLink { key: string; label: string; disabled?: boolean }
interface NavGroup { key: string; label: string; icon: typeof House; links: NavLink[] }

const navOpen = ref(false)
const activeModule = ref<ModuleKey>('products')
const followupCustomerId = ref<string | null>(null)

const dashboard: NavLink = { key: 'dashboard', label: '工作台' }
// 两级结构固定写死：一级是业务板块，二级才是真实页面，避免以后新增页面时又要重排导航
const navGroups: NavGroup[] = [
  { key: 'products', label: '产品管理', icon: Box, links: [
    { key: 'products', label: '产品库' },
    { key: 'suppliers', label: '供应商库' },
  ] },
  { key: 'customers', label: '客户管理', icon: User, links: [
    { key: 'customers', label: '客户档案' },
    { key: 'followup', label: '客户跟进' },
  ] },
  { key: 'documents', label: '报价单证', icon: Document, links: [
    { key: 'quotes', label: '报价管理' },
    { key: 'documents', label: '单证中心' },
    { key: 'templates', label: '单证模板' },
    { key: 'generate', label: '生成单证' },
  ] },
  { key: 'system', label: '系统', icon: Setting, links: [
    { key: 'company', label: '我的企业' },
    // 这两个还没有对应页面，用禁用态占位，避免点了没反应让人以为坏了
    { key: 'settings', label: '系统设置', disabled: true },
    { key: 'help', label: '帮助中心', disabled: true },
  ] },
]
// 当前页所属板块，用于窄栏高亮
const activeGroupKey = computed(() => navGroups.find((group) => group.links.some((link) => link.key === activeModule.value))?.key ?? '')
const activeLabel = computed(() => {
  if (activeModule.value === dashboard.key) return dashboard.label
  for (const group of navGroups) {
    const hit = group.links.find((link) => link.key === activeModule.value)
    if (hit) return hit.label
  }
  return ''
})

// 悬停展开：进出侧栏有延时，避免鼠标扫过时闪一下；焦点进入也展开，保证键盘可用
let timer: ReturnType<typeof setTimeout> | null = null
function clearTimer() { if (timer) { clearTimeout(timer); timer = null } }
function openNav() { clearTimer(); timer = setTimeout(() => { navOpen.value = true }, 90) }
function scheduleCloseNav() { clearTimer(); timer = setTimeout(() => { navOpen.value = false }, 180) }
function toggleNav() { clearTimer(); navOpen.value = !navOpen.value }
function selectModule(key: string) { activeModule.value = key as ModuleKey }
// 窄栏只显示板块图标，点击直接进入该板块的第一个页面
function openGroup(group: NavGroup) {
  const first = group.links.find((link) => !link.disabled)
  if (first) selectModule(first.key)
}
// 从客户档案页跳转：切换模块并携带目标客户 id，由跟进页定位
function openFollowup(customerId: string) { followupCustomerId.value = customerId; activeModule.value = 'followup' }
onBeforeUnmount(() => {
  clearTimer()
  window.removeEventListener(AUTH_EXPIRED_EVENT, onAuthExpired)
})
defineExpose({ openFollowup })
</script>
<template>
  <!-- 身份确认前不渲染业务界面 -->
  <div v-if="!authReady" v-loading="true" class="auth-loading"/>
  <LoginPage v-else-if="!currentUser" @logged-in="onLoggedIn"/>
  <el-container v-else class="app-shell">
    <!-- 侧栏本体脱离常规流：变宽只覆盖内容区，不推开表格，避免布局跳动 -->
    <el-aside width="76px" class="app-sidebar">
      <div class="rail" :class="{ 'is-open': navOpen }" @mouseenter="openNav()" @mouseleave="scheduleCloseNav()" @focusin="openNav()" @focusout="scheduleCloseNav()">
        <div class="brand"><div class="brand-mark">贸</div><div v-show="navOpen" class="brand-copy"><strong>贸易易</strong><span>外贸业务管理系统</span></div><button v-if="navOpen" class="rail-toggle" title="收起导航" @click="toggleNav"><el-icon><Fold/></el-icon></button></div>
        <nav class="nav-rail">
          <button class="rail-link" :class="{ 'is-active': activeModule === dashboard.key }" :title="dashboard.label" @click="selectModule(dashboard.key)">
            <el-icon><House/></el-icon><span>工作台</span>
          </button>
          <!-- 窄栏点击直接进板块第一个页面；悬停展开后再精确选子项 -->
          <button v-for="group in navGroups" :key="group.key" class="rail-link" :class="{ 'is-active': activeGroupKey === group.key }" :title="group.label" @click="openGroup(group)">
            <el-icon><component :is="group.icon"/></el-icon><span>{{ group.label }}</span>
          </button>
        </nav>
        <nav class="nav-full">
          <button class="nav-link nav-link--top" :class="{ 'is-active': activeModule === dashboard.key }" @click="selectModule(dashboard.key)">{{ dashboard.label }}</button>
          <div v-for="group in navGroups" :key="group.key" class="nav-group">
            <div class="nav-caption">{{ group.label }}</div>
            <!-- 子项常驻展开，切板块不用多点一次 -->
            <button v-for="link in group.links" :key="link.key" class="nav-link" :class="{ 'is-active': activeModule === link.key }" :disabled="link.disabled" @click="selectModule(link.key)">{{ link.label }}</button>
          </div>
        </nav>
      </div>
    </el-aside>
    <el-container class="main-container">
      <el-header class="app-header">
        <div class="header-left">
          <el-button class="collapse-button" text @click="toggleNav"><el-icon :size="20"><Fold v-if="navOpen"/><MenuIcon v-else/></el-icon></el-button>
          <span class="header-location">业务中心 / {{ activeLabel }}</span>
        </div>
        <div class="header-right"><span class="header-date">外贸业务管理工作台</span><el-divider direction="vertical"/><el-avatar :size="34" class="user-avatar"><UserFilled/></el-avatar><div class="user-info"><strong>{{ currentUser?.displayName || currentUser?.username }}</strong><span>{{ currentUser?.username }}</span></div><el-divider direction="vertical"/><el-button link size="small" @click="logout">退出登录</el-button></div>
      </el-header>
      <el-main class="app-content"><ProductLibrary v-if="activeModule === 'products'"/><SupplierLibrary v-else-if="activeModule === 'suppliers'"/><CustomerLibrary v-else-if="activeModule === 'customers'" @followup="openFollowup"/><CustomerFollowUp v-else-if="activeModule === 'followup'" :initial-customer-id="followupCustomerId"/><QuoteManagement v-else-if="activeModule === 'quotes'"/><DocumentCenter v-else-if="activeModule === 'documents'"/><MyCompany v-else-if="activeModule === 'company'"/><DocumentTemplates v-else-if="activeModule === 'templates'"/><DocumentGenerate v-else-if="activeModule === 'generate'"/><el-empty v-else description="工作台将在后续迭代中开放" class="module-placeholder"/></el-main>
    </el-container>
  </el-container>
</template>

<style>
.auth-loading { position: fixed; inset: 0; }
</style>
