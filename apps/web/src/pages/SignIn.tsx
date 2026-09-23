import { useState } from "react";
import { useAuth } from "../lib/auth";
import { workspaceDomain } from "../lib/firebase";

export function SignIn({ message }: { message?: string }) {
  const { signIn } = useAuth();
  const [error, setError] = useState<string | null>(null);
  return (
    <main className="signin">
      <div className="signin-card">
        <h1>Business Dashboard</h1>
        <p className="muted">Sign in with your {workspaceDomain ? `@${workspaceDomain}` : "organization"} Google account.</p>
        {(message || error) && <div className="error-banner">{message ?? error}</div>}
        <button
          type="button"
          className="button button-primary"
          onClick={() => signIn().catch((e: Error) => setError(e.message.replace(/^Firebase: /, "")))}
        >
          Sign in with Google
        </button>
      </div>
    </main>
  );
}
