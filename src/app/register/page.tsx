import Link from "next/link";
import { RegisterForm } from "./RegisterForm";
import { isRegistrationOpen } from "@/lib/registration";

export const dynamic = "force-dynamic";

export default async function RegisterPage() {
  const open = await isRegistrationOpen();

  return (
    <div className="flex flex-1 items-center justify-center px-4">
      {open ? (
        <RegisterForm />
      ) : (
        <div className="w-full max-w-sm rounded-xl border border-gray-200 p-6 text-center dark:border-gray-700">
          <h1 className="mb-1 text-xl font-bold">PostMaid</h1>
          <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">
            ขณะนี้ระบบปิดรับสมัครสมาชิกใหม่
          </p>
          <Link
            href="/login"
            className="inline-block rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"
          >
            เข้าสู่ระบบ
          </Link>
        </div>
      )}
    </div>
  );
}
