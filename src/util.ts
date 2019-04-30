export function log(marker: string, ...args: any) {
  const date = new Date()
  const year = date.getFullYear()
  const month = (date.getMonth() + 1).toString().padStart(2, '0')
  const day = date.getDate().toString().padStart(2, '0')
  const hour = date.getHours().toString().padStart(2, '0')
  const minute = date.getMinutes().toString().padStart(2, '0')
  const second = date.getSeconds().toString().padStart(2, '0')

  const appendix = typeof args[0] === 'string' && args[0].includes('{}')
    ? ' ' + args.shift().replace(/\{\}/g, '%s')
    : ''

  // tslint:disable-next-line: no-console
  console.log(
    '\x1b[30;1m%s-%s-%s %s:%s:%s\x1b[0m \x1b[35m[%s]\x1b[0m:' + appendix,
    year, month, day, hour, minute, second, marker, ...args,
  )
}
