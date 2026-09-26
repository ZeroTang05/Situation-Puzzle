/**
 * 本地 SMTP 收信台：最小 SMTP 协议实现（EHLO/AUTH LOGIN/MAIL/RCPT/DATA）。
 * 用途：联调时 better-auth → nodemailer → 本收信台投递验证码，测试脚本从收到的
 * 邮件正文提取 OTP。只监听 127.0.0.1，联调结束退出。
 */
import net from 'node:net';
import { writeFileSync } from 'node:fs';

const PORT = Number(process.env.SINK_PORT ?? 2526);
const OUT_FILE = process.env.SINK_OUT ?? 'mailsink.json';

/** 每封邮件：{ to, subject, text, at }；脚本通过读 OUT_FILE 拿验证码 */
const mailbox = [];

function flush() {
  writeFileSync(OUT_FILE, JSON.stringify(mailbox.slice(-50), null, 2));
}

function extractBody(raw) {
  // 解析 text/plain 部分：multipart/alternative（text+html 邮件）取 plain 段，
  // 单部分邮件取整个正文。编码按该段的 Content-Transfer-Encoding 处理。
  const boundaryMatch = raw.match(/boundary="?([^"\r\n;]+)"?/i);
  let section = raw;
  if (boundaryMatch) {
    const sections = raw.split(`--${boundaryMatch[1]}`);
    const plain = sections.find((s) => /Content-Type:\s*text\/plain/i.test(s));
    if (plain) section = plain;
  }
  const headerEnd = section.search(/\r?\n\r?\n/);
  if (headerEnd < 0) return '';
  const headers = section.slice(0, headerEnd);
  const body = section.slice(headerEnd).replace(/^\r?\n\r?\n/, '').trim();
  if (/Content-Transfer-Encoding:\s*base64/i.test(headers)) {
    return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
  }
  if (/Content-Transfer-Encoding:\s*quoted-printable/i.test(headers)) {
    return body
      .replace(/=\r?\n/g, '')
      .replace(/=([0-9A-F]{2})/gi, (_, hex) => Buffer.from(hex, 'hex').toString());
  }
  return body;
}

function extractTo(raw) {
  const m = raw.match(/^To:\s*(.*)$/im);
  return m ? m[1].trim() : '';
}

net.createServer((socket) => {
  let buffer = '';
  let inData = false;
  let authState = 0;
  let mailRaw = '';

  socket.write('220 localsink ESMTP ready\r\n');

  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    while (buffer.includes('\r\n') || buffer.includes('\n')) {
      const nl = buffer.indexOf('\r\n') >= 0 ? buffer.indexOf('\r\n') : buffer.indexOf('\n');
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + (buffer[nl] === '\r' ? 2 : 1));

      if (inData) {
        if (line === '.') {
          inData = false;
          mailbox.push({ to: extractTo(mailRaw), body: extractBody(mailRaw), raw: mailRaw, at: Date.now() });
          flush();
          mailRaw = '';
          socket.write('250 OK: queued\r\n');
        } else {
          mailRaw += (line === '..' ? '.' : line) + '\n';
        }
        continue;
      }

      const cmd = line.toUpperCase();
      if (cmd.startsWith('EHLO') || cmd.startsWith('HELO')) {
        socket.write('250-localsink\r\n250-SIZE 1048576\r\n250-AUTH PLAIN LOGIN\r\n250 OK\r\n');
      } else if (cmd.startsWith('AUTH PLAIN')) {
        socket.write('235 2.7.0 Accepted\r\n');
      } else if (cmd.startsWith('AUTH LOGIN')) {
        authState = 1;
        socket.write('334 VXNlcm5hbWU6\r\n');
      } else if (authState === 1) {
        authState = 2;
        socket.write('334 UGFzc3dvcmQ6\r\n');
      } else if (authState === 2) {
        authState = 0;
        socket.write('235 2.7.0 Accepted\r\n');
      } else if (cmd.startsWith('MAIL FROM')) {
        socket.write('250 OK\r\n');
      } else if (cmd.startsWith('RCPT TO')) {
        socket.write('250 OK\r\n');
      } else if (cmd.startsWith('DATA')) {
        inData = true;
        socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
      } else if (cmd.startsWith('QUIT')) {
        socket.write('221 Bye\r\n');
        socket.end();
      } else if (cmd.startsWith('RSET') || cmd.startsWith('NOOP')) {
        socket.write('250 OK\r\n');
      } else {
        socket.write('250 OK\r\n');
      }
    }
  });

  socket.on('error', () => {});
}).listen(PORT, '127.0.0.1', () => {
  console.log(`[mailsink] SMTP 收信台已启动：127.0.0.1:${PORT} → ${OUT_FILE}`);
});
