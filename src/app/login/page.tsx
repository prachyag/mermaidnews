import { isRegistrationOpen } from "@/lib/registration";
import { LoginForm } from "./LoginForm";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const registrationOpen = await isRegistrationOpen();
  return (
    <div className="flex flex-1 items-center justify-center px-4">
      <LoginForm registrationOpen={registrationOpen} />
    </div>
  );
}
