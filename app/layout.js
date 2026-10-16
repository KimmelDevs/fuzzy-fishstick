import './globals.css';

export const metadata = {
  title: 'Mic Studio',
  description: 'Hear your microphone live in your earphones and record it.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
