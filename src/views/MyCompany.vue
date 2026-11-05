<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { OfficeBuilding, Refresh, Upload, User } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { api } from '../services/api'
import type { MyCompany } from '../types/domain'

// 单条记录：进页面即读取，保存时整表覆盖
const form = reactive<Omit<MyCompany, 'id' | 'updatedAt'>>({
  nameCn: '', nameEn: '', addressCn: '', addressEn: '', tel: '', fax: '', email: '', website: '', zip: '',
  unifiedCode: '', customsCode: '', logo: '',
  beneficiaryAccount: '', swiftCode: '', beneficiaryCountry: '', beneficiaryName: '', beneficiaryAddress: '',
  beneficiaryBank: '', beneficiaryBankAddress: '', bankCode: '', branchCode: '',
})
const loading = ref(false); const saving = ref(false); const updatedAt = ref('')

async function load() {
  loading.value = true
  try {
    const data = await api.documents.myCompany.get()
    const { id: _id, updatedAt: saved, ...fields } = data
    Object.assign(form, fields); updatedAt.value = saved || ''
  } catch (error) { ElMessage.error((error as Error).message) } finally { loading.value = false }
}
async function save() {
  if (!form.nameEn && !form.nameCn) return ElMessage.warning('请至少填写公司中文名或英文名')
  saving.value = true
  try { const data = await api.documents.myCompany.save({ ...form }); updatedAt.value = data.updatedAt; ElMessage.success('企业信息已保存') }
  catch (error) { ElMessage.error((error as Error).message) } finally { saving.value = false }
}
// 公司 Logo 复用现有图片上传接口，返回的 URL 直接存进企业资料
async function uploadLogo(options: { file: File }) {
  const formData = new FormData(); formData.append('image', options.file)
  try {
    const response = await fetch('/api/uploads', { method: 'POST', body: formData, credentials: 'same-origin' })
    if (!response.ok) throw new Error('上传失败')
    const data = await response.json(); form.logo = data.url; ElMessage.success('Logo 已上传')
  } catch (error) { ElMessage.error((error as Error).message) }
}

onMounted(() => load())
</script>
<template>
  <div class="page-view" v-loading="loading">
    <div class="page-heading">
      <div><h1>我的企业</h1><p>维护卖方抬头与银行收款信息，生成 PI / 发票时自动填充；只需填写一次</p></div>
      <div class="heading-actions">
        <span v-if="updatedAt" class="muted">最近保存：{{ updatedAt }}</span>
        <el-button :icon="Refresh" @click="load">重新读取</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
      </div>
    </div>

    <el-card class="content-card" shadow="never">
      <template #header><div class="card-title"><el-icon><OfficeBuilding/></el-icon><strong>公司资料</strong><span class="muted">单证页眉、Seller 栏位使用</span></div></template>
      <el-form label-width="130px">
        <el-row :gutter="18">
          <el-col :xs="24" :sm="12"><el-form-item label="公司中文名"><el-input v-model="form.nameCn"/></el-form-item></el-col>
          <el-col :xs="24" :sm="12"><el-form-item label="公司英文名"><el-input v-model="form.nameEn"/></el-form-item></el-col>
          <el-col :xs="24"><el-form-item label="中文地址"><el-input v-model="form.addressCn"/></el-form-item></el-col>
          <el-col :xs="24"><el-form-item label="英文地址"><el-input v-model="form.addressEn"/></el-form-item></el-col>
          <el-col :xs="12" :sm="6"><el-form-item label="电话 TEL"><el-input v-model="form.tel"/></el-form-item></el-col>
          <el-col :xs="12" :sm="6"><el-form-item label="传真 FAX"><el-input v-model="form.fax"/></el-form-item></el-col>
          <el-col :xs="12" :sm="6"><el-form-item label="邮编"><el-input v-model="form.zip"/></el-form-item></el-col>
          <el-col :xs="12" :sm="6"><el-form-item label="邮箱"><el-input v-model="form.email"/></el-form-item></el-col>
          <el-col :xs="12" :sm="6"><el-form-item label="网站"><el-input v-model="form.website"/></el-form-item></el-col>
          <el-col :xs="12" :sm="9"><el-form-item label="统一社会信用代码"><el-input v-model="form.unifiedCode"/></el-form-item></el-col>
          <el-col :xs="12" :sm="9"><el-form-item label="报关企业代码"><el-input v-model="form.customsCode"/></el-form-item></el-col>
          <el-col :xs="24">
            <el-form-item label="公司 Logo">
              <div class="logo-row">
                <el-avatar v-if="form.logo" :src="form.logo" :size="56" shape="square"/>
                <el-upload :show-file-list="false" :http-request="uploadLogo as any" accept="image/jpeg,image/png,image/webp">
                  <el-button :icon="Upload">上传 Logo</el-button>
                </el-upload>
                <span class="muted">JPG / PNG / WebP，≤5MB</span>
              </div>
            </el-form-item>
          </el-col>
        </el-row>
      </el-form>
    </el-card>

    <el-card class="content-card" shadow="never">
      <template #header><div class="card-title"><el-icon><User/></el-icon><strong>银行收款信息</strong><span class="muted">PI 的 Beneficiary 区块使用，与阿里巴巴国际站后台的英文 TT 账号一致</span></div></template>
      <el-form label-width="170px">
        <el-row :gutter="18">
          <el-col :xs="24" :sm="12"><el-form-item label="Beneficiary account number"><el-input v-model="form.beneficiaryAccount"/></el-form-item></el-col>
          <el-col :xs="24" :sm="12"><el-form-item label="SWIFT code"><el-input v-model="form.swiftCode"/></el-form-item></el-col>
          <el-col :xs="24" :sm="12"><el-form-item label="Beneficiary country/region"><el-input v-model="form.beneficiaryCountry"/></el-form-item></el-col>
          <el-col :xs="24" :sm="12"><el-form-item label="Beneficiary name"><el-input v-model="form.beneficiaryName"/></el-form-item></el-col>
          <el-col :xs="24"><el-form-item label="Beneficiary address"><el-input v-model="form.beneficiaryAddress"/></el-form-item></el-col>
          <el-col :xs="24" :sm="12"><el-form-item label="Beneficiary bank"><el-input v-model="form.beneficiaryBank"/></el-form-item></el-col>
          <el-col :xs="24" :sm="12"><el-form-item label="Beneficiary bank address"><el-input v-model="form.beneficiaryBankAddress"/></el-form-item></el-col>
          <el-col :xs="12" :sm="6"><el-form-item label="Bank code"><el-input v-model="form.bankCode"/></el-form-item></el-col>
          <el-col :xs="12" :sm="6"><el-form-item label="Branch code"><el-input v-model="form.branchCode"/></el-form-item></el-col>
        </el-row>
      </el-form>
    </el-card>
  </div>
</template>
<style scoped>
.heading-actions { display: flex; align-items: center; gap: 12px; }
.card-title { display: flex; align-items: center; gap: 8px; }
.muted { color: #909399; font-size: 12px; }
.logo-row { display: flex; align-items: center; gap: 12px; }
</style>
