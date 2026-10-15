export default function Home() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100">
      <main className="text-center">
        <h1 className="text-6xl font-bold text-blue-600 mb-4">
          Project Blue
        </h1>
        <p className="text-xl text-gray-700 mb-8">
          A Next.js project with Vercel Web Analytics
        </p>
        <div className="bg-white p-6 rounded-lg shadow-lg max-w-md mx-auto">
          <p className="text-gray-600">
            Vercel Web Analytics is now configured and ready to track visitors.
          </p>
        </div>
      </main>
    </div>
  );
}
