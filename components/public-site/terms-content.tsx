import Link from "next/link";

import {
  ContactDetails,
  LegalDocument,
  type LegalSectionContent
} from "@/components/public-site/legal-document";
import { textLink } from "@/components/public-site/styles";
import { LEGAL_OPERATOR_NAME } from "@/lib/public-site";

/**
 * Parfait Terms of Service. Product-ready draft; not attorney reviewed. Deliberately contains no
 * legal entity details, governing law, venue or arbitration terms, because none are provided by
 * the repository. Counsel should add whichever of those apply before launch.
 */

export const termsSections: LegalSectionContent[] = [
  {
    id: "acceptance",
    title: "Acceptance of these terms",
    body: (
      <p>
        By creating an account or using Parfait, you agree to these Terms of Service and to our{" "}
        <Link href="/privacy" className={textLink}>
          Privacy Policy
        </Link>
        . If you do not agree, do not use the Service. If you use Parfait on behalf of an
        organization, you confirm that you have authority to bind it to these terms.
      </p>
    )
  },
  {
    id: "service",
    title: "The Service",
    body: (
      <p>
        Parfait is an AI-powered meeting execution workspace. It can send a notetaker bot into
        meetings you add, transcribe them, and generate commitments, tasks, decisions, deliverables
        and follow-up drafts. Features may change, and some may be experimental.
      </p>
    )
  },
  {
    id: "eligibility",
    title: "Eligibility",
    body: (
      <p>
        You must be at least 18 years old and able to form a binding contract to use Parfait. You
        may not use the Service if you are barred from doing so under applicable law.
      </p>
    )
  },
  {
    id: "accounts",
    title: "Your account",
    body: (
      <ul>
        <li>Give accurate information and keep it up to date.</li>
        <li>
          Keep your credentials secure. You are responsible for activity on your account, and
          should tell us promptly if you suspect unauthorized access.
        </li>
        <li>
          You may sign in with email and password or with Google. Signing in with Google is
          governed by these terms as well as Google&apos;s own terms.
        </li>
      </ul>
    )
  },
  {
    id: "recording-consent",
    title: "Recording, transcription and consent",
    body: (
      <>
        <p>
          Parfait can record and transcribe conversations. You are solely responsible for making
          sure you have the right to do so before you add a meeting to Parfait. That includes:
        </p>
        <ul>
          <li>
            complying with all laws that apply to recording, transcribing or analyzing
            conversations in every place where participants are located, including any
            requirement to notify participants or obtain their consent;
          </li>
          <li>
            complying with the policies of your organization and of the meeting platform, such as
            Google Meet or Zoom; and
          </li>
          <li>informing participants that a notetaker bot will join and the meeting will be transcribed.</li>
        </ul>
        <p>
          Parfait does not determine whether recording or transcribing a particular meeting is
          lawful, and it does not obtain consent for you. Do not add a meeting if you do not have
          the necessary permissions.
        </p>
      </>
    )
  },
  {
    id: "your-content",
    title: "Your content",
    body: (
      <>
        <p>
          &ldquo;Your content&rdquo; means what you add to Parfait or that Parfait creates from it:
          meeting links, transcripts, projects, notes, and generated tasks, commitments, decisions,
          deliverables and drafts. As between you and Parfait, you keep your rights in your
          content.
        </p>
        <p>
          You give us permission to host, process, copy and display your content, and to send it to
          the service providers described in the Privacy Policy, only as needed to provide and
          secure the Service for you. You are responsible for your content and for having the right
          to add it, including the speech of other people in your meetings.
        </p>
      </>
    )
  },
  {
    id: "ai-output",
    title: "AI-generated output and its limits",
    body: (
      <>
        <p>
          Parfait uses artificial intelligence. Its output can be incomplete, incorrect, out of
          context or misattributed, for example a missed commitment, a wrong owner or due date, or a
          task that was not actually agreed. Transcription can also contain errors.
        </p>
        <p>
          Review output before you rely on it. Parfait is not a substitute for professional
          advice, and you are responsible for decisions and actions you take based on it. Outputs
          may not be unique, and similar outputs may be generated for other users.
        </p>
      </>
    )
  },
  {
    id: "acceptable-use",
    title: "Acceptable use",
    body: (
      <>
        <p>You agree not to:</p>
        <ul>
          <li>break the law or infringe the rights of others, including privacy and recording laws;</li>
          <li>record or process meetings without the permissions described above;</li>
          <li>upload or generate content that is unlawful, harassing, or that you have no right to use;</li>
          <li>attempt to access another user&apos;s account or data, or probe or bypass security;</li>
          <li>disrupt or overload the Service, or use it to build a competing product through scraping or automated extraction;</li>
          <li>reverse engineer the Service except where the law allows it; or</li>
          <li>use the Service to send spam or malware.</li>
        </ul>
      </>
    )
  },
  {
    id: "third-parties",
    title: "Third-party services",
    body: (
      <p>
        Parfait relies on third parties, including Supabase, Recall.ai, OpenAI, Vercel and Google,
        and works alongside meeting platforms such as Google Meet and Zoom. Your use of those
        platforms is governed by their own terms. We are not responsible for third-party services,
        and the Service may be affected if they change or become unavailable.
      </p>
    )
  },
  {
    id: "intellectual-property",
    title: "Intellectual property",
    body: (
      <p>
        Parfait, including its software, design and branding, belongs to us and our licensors. We
        give you a limited, non-exclusive, non-transferable right to use the Service under these
        terms. If you send us feedback, we may use it without obligation to you.
      </p>
    )
  },
  {
    id: "availability",
    title: "Availability and changes to the Service",
    body: (
      <p>
        We work to keep Parfait available, but we do not promise uninterrupted or error-free
        service. We may change, suspend or discontinue features, and may perform maintenance.
      </p>
    )
  },
  {
    id: "termination",
    title: "Termination",
    body: (
      <p>
        You can stop using Parfait at any time. To close your account and delete your data, contact
        us as described in the Privacy Policy. We may suspend or end your access if you breach
        these terms, if we need to protect the Service or others, or if we discontinue the
        Service. Sections that by their nature should continue (such as those on disclaimers and
        limits of liability) will survive termination.
      </p>
    )
  },
  {
    id: "disclaimers",
    title: "Disclaimers",
    body: (
      <p>
        To the maximum extent permitted by law, the Service is provided &ldquo;as is&rdquo; and
        &ldquo;as available&rdquo; without warranties of any kind, whether express or implied,
        including warranties of merchantability, fitness for a particular purpose, accuracy and
        non-infringement. We do not warrant that AI output or transcripts will be accurate or
        complete, or that the Service will meet your requirements.
      </p>
    )
  },
  {
    id: "liability",
    title: "Limitation of liability",
    body: (
      <p>
        To the maximum extent permitted by law, Parfait{LEGAL_OPERATOR_NAME ? ` (${LEGAL_OPERATOR_NAME})` : ""} will not be liable for any indirect, incidental, special,
        consequential or punitive damages, or for loss of profits, data or goodwill, arising from
        your use of the Service. Our total liability for any claim relating to the Service will
        not exceed the amount you paid us for the Service in the twelve months before the claim.
        Nothing in these terms limits liability that cannot be limited by law.
      </p>
    )
  },
  {
    id: "changes",
    title: "Changes to these terms",
    body: (
      <p>
        We may update these terms. We will post the new version here and update the effective date.
        If you keep using Parfait after a change takes effect, you accept the updated terms. For
        material changes we will take reasonable steps to notify you.
      </p>
    )
  },
  {
    id: "contact",
    title: "Contact",
    body: <ContactDetails topic="questions about these terms" />
  }
];

export function TermsOfService({ signedIn }: { signedIn: boolean }) {
  return (
    <LegalDocument
      title="Terms of Service"
      signedIn={signedIn}
      sections={termsSections}
      lead={
        <p>
          These terms govern your use of Parfait{LEGAL_OPERATOR_NAME ? `, operated by ${LEGAL_OPERATOR_NAME},` : ""}{" "}
          at parfait-app.com (the &ldquo;Service&rdquo;). Please read them together with our{" "}
          <Link href="/privacy" className={textLink}>
            Privacy Policy
          </Link>
          . In these terms, &ldquo;Parfait&rdquo;, &ldquo;we&rdquo; and &ldquo;us&rdquo; mean the
          operator of the Service.
        </p>
      }
    />
  );
}
