import nodemailer from 'nodemailer';

interface EmailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

interface EmailOptions {
  to: string;
  subject: string;
  html: string;
  attachments?: EmailAttachment[];
}

export async function sendEmailNotification(options: EmailOptions) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS, // Gmail 앱 비밀번호
    },
  });

  const mailAttachments = (options.attachments || []).map(a => ({
    filename: a.filename,
    content: a.content,
    contentType: a.contentType,
  }));

  await transporter.sendMail({
    from: `"MAWINPAY JARVIS" <${process.env.EMAIL_USER}>`,
    to: options.to,
    subject: options.subject,
    html: options.html,
    attachments: mailAttachments,
  });
}
