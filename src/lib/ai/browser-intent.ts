/** Route only short, read-only browser lookups to the bounded browser tool. */
export function isCurrentWeatherLookup(text: string): boolean {
  if (text.length > 500 || !/天气|weather|temperature|气温/i.test(text)) return false;
  if (/写(?:一个|个)?|代码|编程|制作|开发|网页|网站|历史|去年|过去|code|build|create|history/i.test(text)) return false;
  return true;
}

export function isSimpleBrowserLookup(text: string): boolean {
  if (text.length > 500) return false;
  if (!/(?:chrome|浏览器|网页|网站|web|weather|天气)/i.test(text)) return false;
  if (!/(?:打开|搜索|查询|查(?:一下|看|找)?|看看|告诉|read|open|search|look up)/i.test(text)) return false;
  // Tasks with interactive or external effects need the full computer toolbox.
  if (/(?:登录|提交|付款|支付|购买|下单|发送|发布|上传|下载|编辑|修改|删除|填写|点击|表单|设置|install|login|submit|pay|purchase|send|publish|upload|download|edit|delete|click|form)/i.test(text)) return false;
  return true;
}
