import { donationUrl } from "@/src/lib/donations";

export function DonationFooter() {
  const url = donationUrl(process.env.DONATION_URL);
  return (
    <footer className="donation-footer">
      <div>
        <h2>Help keep Numa running</h2>
        <p>Optional donations help cover hosting and keep this little sharing space online.</p>
        {!url && <p>Donations are not set up yet. Sharing is still free to use.</p>}
      </div>
      {url
        ? <a className="button button-secondary" href={url} target="_blank" rel="noopener noreferrer">Donate <span className="visually-hidden">(opens hosted payment provider in a new tab)</span>↗</a>
        : <button className="button button-secondary" disabled title="The site owner has not configured a donation link">Donate — coming soon</button>}
    </footer>
  );
}
