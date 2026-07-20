import Logo from './Logo.jsx'
import { useT } from '../lib/i18n.jsx'

export default function Welcome() {
  const t = useT()
  return (
    <div className="h-full flex flex-col items-center justify-center px-4 animate-fade-in">
      <div className="mb-5">
        <Logo size={56} />
      </div>
      <h1 className="text-3xl md:text-4xl font-extrabold tracking-tight text-center">
        AI <span className="prism-text">Prism</span>
      </h1>
      <p className="text-[var(--muted)] mt-2 text-center max-w-md">
        {t('welcome.subtitle')}
      </p>
    </div>
  )
}
