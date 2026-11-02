import { AgentsSection } from '../components/site/AgentsSection';
import { Hero } from '../components/site/Hero';
import { InstallSection } from '../components/site/InstallSection';
import { PocketSection } from '../components/site/PocketSection';
import { PlaySection } from '../components/site/PlaySection';
import { ReelSection } from '../components/site/ReelSection';
import { SiteFooter } from '../components/site/SiteFooter';
import { SiteNav } from '../components/site/SiteNav';
import { TourSection } from '../components/site/TourSection';
import { WhySection } from '../components/site/WhySection';
import { WorkersSection } from '../components/site/WorkersSection';

export function Landing() {
  return (
    <div className="min-h-full w-full bg-bg-void font-body text-text">
      <SiteNav />
      <main>
        <Hero />
        <ReelSection />
        <PlaySection />
        <TourSection />
        <AgentsSection />
        <WorkersSection />
        <WhySection />
        <PocketSection />
        <InstallSection />
      </main>
      <SiteFooter />
    </div>
  );
}
