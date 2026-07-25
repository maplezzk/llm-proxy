import { useTheme } from '@appica/ui-react/hooks/use-theme'
import { Button } from '@appica/ui-react/button'
import { Sun, Moon } from '@appica/icons-react'

export default function App() {
  const { resolvedTheme, setTheme, mounted } = useTheme()
  const isDark = mounted && resolvedTheme === 'dark'

  return (
    <div className="min-h-screen bg-background text-foreground">
      <main className="mx-auto max-w-3xl p-8">
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <p className="mt-2 text-muted-foreground">
          Walking Skeleton — Appica UI 组件库样式与主题验证。
        </p>
        <div className="mt-6">
          <Button
            variant="outline"
            onClick={() => setTheme(isDark ? 'light' : 'dark')}
          >
            {isDark ? <Sun /> : <Moon />}
            <span className="ml-2">{isDark ? 'Light' : 'Dark'}</span>
          </Button>
        </div>
      </main>
    </div>
  )
}
