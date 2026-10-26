// Taro 4 + React：babel 只做框架桥接与兼容转译（ES5 转换交给小程序基础库开关）
module.exports = {
  presets: [
    ['taro', { framework: 'react', ts: true }]
  ]
}
