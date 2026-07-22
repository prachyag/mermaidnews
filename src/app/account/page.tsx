import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { resolveUserId, SESSION_COOKIE } from "@/lib/session";
import { getAccount, toAccountDTO } from "@/lib/account";
import { AccountForms } from "./AccountForms";

export const dynamic = "force-dynamic";

export default async function AccountPage() {
  const userId = await resolveUserId((await cookies()).get(SESSION_COOKIE)?.value);
  if (userId === null) redirect("/login");
  const user = await getAccount(userId);
  if (!user) redirect("/login");

  return (
    <main className="mx-auto w-full max-w-lg px-4 py-6">
      <h1 className="mb-1 text-xl font-bold">ตั้งค่าบัญชี</h1>
      <p className="mb-6 text-sm text-gray-500 dark:text-gray-400">
        ชื่อผู้ใช้: <span className="font-medium">{user.username}</span> (เปลี่ยนไม่ได้)
      </p>
      <AccountForms initial={toAccountDTO(user)} />
    </main>
  );
}
