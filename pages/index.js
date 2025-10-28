import Link from "next/link";

export default function Home() {
  return (
    <main style={{ fontFamily: "sans-serif", padding: "40px" }}>
      <h1>FFL Verifier App — Online</h1>
      <p>This is the starting page for your rebuilt application.</p>
      <p>Next we’ll add the upload and verification logic.</p>
      <Link href="/upload" legacyBehavior>
        <a
          style={{
            display: "inline-block",
            marginTop: 24,
            padding: "10px 18px",
            background: "#1976d2",
            color: "#ffffff",
            borderRadius: 6,
            textDecoration: "none",
            fontWeight: 600,
          }}
        >
          Go to Upload Tool →
        </a>
      </Link>
    </main>
  );
}
