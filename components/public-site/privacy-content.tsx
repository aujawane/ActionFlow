import Link from "next/link";

import {
  ContactDetails,
  LegalDocument,
  type LegalSectionContent
} from "@/components/public-site/legal-document";
import { textLink } from "@/components/public-site/styles";
import { LEGAL_OPERATOR_NAME } from "@/lib/public-site";

/**
 * Parfait Privacy Policy. Statements about data flows were checked against the repository (auth
 * form, the Recall/OpenAI integrations, the Supabase schema). If the
 * code changes how data is collected, used, stored or shared, update this document with it.
 *
 * Two kinds of statement CANNOT be proven from source code and must not be presented as
 * repository-verified:
 *  - Resend as the SMTP provider for Supabase Auth emails. It is configured in the Supabase
 *    dashboard (not in this repo); it is included on the operator's confirmation.
 *  - Anything about hosting-dashboard settings (for example whether Vercel analytics is on).
 *    The policy therefore makes no claim about analytics either way.
 * Product-ready draft; not attorney reviewed.
 */

const GOOGLE_POLICY_URL = "https://developers.google.com/terms/api-services-user-data-policy";
const GOOGLE_PERMISSIONS_URL = "https://myaccount.google.com/permissions";

export const privacySections: LegalSectionContent[] = [
  {
    id: "summary",
    title: "The short version",
    navLabel: "The short version",
    body: (
      <ul>
        <li>
          Parfait turns meetings into commitments, tasks, decisions and follow-up. To do that, it
          processes your account details and the transcripts of the meetings you add.
        </li>
        <li>
          If you sign in with Google, we receive only your basic profile: name, email address,
          profile picture and Google account identifier. We do not access your Gmail, Google
          Drive, Calendar or contacts.
        </li>
        <li>
          Meeting content is processed by service providers that run Parfait: Supabase, Recall.ai,
          OpenAI and Vercel. Account and authentication emails are delivered through Resend, which
          does not receive meeting content. Details are below.
        </li>
        <li>We do not sell your personal information and we do not show advertising.</li>
      </ul>
    )
  },
  {
    id: "information-we-collect",
    title: "Information we collect",
    navLabel: "Information we collect",
    body: (
      <>
        <h3>Account information</h3>
        <p>
          When you create an account we collect your email address and, if you provide it, your
          name. If you sign up with a password, it is handled by our authentication provider
          (Supabase); we do not store or see it in readable form. We also keep basic account
          records such as when your account was created and when you last signed in, and a record
          of security events such as password changes (which can include your IP address).
        </p>

        <h3>Google Sign In information</h3>
        <p>
          If you choose Continue with Google, Google shares your basic profile with us. See{" "}
          <a href="#google-user-data" className={textLink}>
            Google Sign In and Google User Data
          </a>{" "}
          below.
        </p>

        <h3>Meeting and transcript information</h3>
        <p>
          When you add a meeting, you give us the meeting link and a title. Parfait then sends a
          bot named &ldquo;Parfait Notetaker&rdquo; into the meeting. Our transcription provider,
          Recall.ai, produces a transcript, which we receive and store. A transcript includes what
          was said, speaker names or labels as the meeting platform provides them, and timestamps.
          Parfait does not itself store audio or video recordings of your meetings.
        </p>

        <h3>Projects and workspace data</h3>
        <p>
          Projects you create, the meetings you assign to them, project vocabulary (names and
          terms you approve), participants, and notes, comments and corrections you make.
        </p>

        <h3>Content Parfait generates</h3>
        <p>
          Commitments, tasks, decisions, insights, summaries, deliverables and follow-up email
          drafts that Parfait generates from your meetings, plus the questions you ask Parfait and
          its answers (for example in project or meeting conversations). Follow-up emails are
          drafts only; Parfait does not send email on your behalf.
        </p>

        <h3>Technical information</h3>
        <p>
          Like most web services, our hosting infrastructure and server logs record technical
          details of requests, such as IP address, browser type, device information, pages
          requested and error information. We use this to run, secure and troubleshoot the
          Service.
        </p>
      </>
    )
  },
  {
    id: "google-user-data",
    title: "Google Sign In and Google User Data",
    navLabel: "Google Sign In",
    body: (
      <>
        <p>
          Parfait uses Google only for sign-in. This section explains exactly what is accessed.
        </p>

        <h3>Continue with Google (sign-in)</h3>
        <p>
          <strong>What we access.</strong> When you choose Continue with Google on the sign-in
          page, Parfait asks Google only to confirm who you are. We request no additional Google
          API scopes for sign-in. Google shares basic profile information: your name, email
          address, profile picture and Google account identifier.
        </p>
        <p>
          <strong>How we use it.</strong> To create and secure your Parfait account, to sign you
          in, to show your name and initials in the app, and to send account and security
          messages. We do not use it for advertising.
        </p>
        <p>
          <strong>How it is stored.</strong> Yes, it is stored. Your name, email address and
          profile picture are kept in our database, hosted by Supabase, for as long as your
          account exists.
        </p>
        <p>
          <strong>Who it is shared with.</strong> Only with the service providers that run Parfait:
          Supabase for authentication and the database, Vercel for hosting, and Resend, which
          receives your email address only when we send you an account or security email. We do
          not send your Google profile information to our AI or transcription providers as part
          of analyzing meetings.
        </p>

        <h3>What we do not access</h3>
        <p>
          Parfait does not call any Google service APIs, and does not request access to your
          Gmail, Google Drive, Google Calendar, contacts or Google Meet. You can review or remove
          the access you have given Parfait at any time in{" "}
          <a href={GOOGLE_PERMISSIONS_URL} className={textLink} rel="noopener noreferrer">
            your Google Account permissions
          </a>
          .
        </p>

        <h3>Limited Use</h3>
        <p>
          Parfait&apos;s use and transfer to any other app of information received from Google
          APIs will adhere to the{" "}
          <a href={GOOGLE_POLICY_URL} className={textLink} rel="noopener noreferrer">
            Google API Services User Data Policy
          </a>
          , including the Limited Use requirements. In practice:
        </p>
        <ul>
          <li>We use Google user data only to provide and improve the user-facing features described above.</li>
          <li>We do not sell Google user data, and we do not use it for advertising.</li>
          <li>
            We do not transfer Google user data to others except to provide those features
            through the service providers listed in this policy, to comply with law, or as part
            of a merger or sale of the business with notice to you.
          </li>
          <li>
            Our team does not read Google user data except with your consent (for example when you
            ask for support), where needed for security or to investigate abuse, or to comply with
            law.
          </li>
          <li>We do not use Google user data to train generalized AI or machine-learning models.</li>
        </ul>
      </>
    )
  },
  {
    id: "how-we-use",
    title: "How we use information",
    navLabel: "How we use information",
    body: (
      <ul>
        <li>To provide Parfait: create your account, join meetings you add, transcribe them, and produce commitments, tasks, decisions and other outputs.</li>
        <li>To let you organize, review, correct and act on that work, and to answer questions you ask about your meetings and projects.</li>
        <li>To send account messages such as email confirmation, password reset and one-time verification codes.</li>
        <li>To secure the Service, prevent abuse, and troubleshoot problems.</li>
        <li>To comply with legal obligations and enforce our Terms of Service.</li>
      </ul>
    )
  },
  {
    id: "ai-processing",
    title: "AI processing",
    navLabel: "AI processing",
    body: (
      <>
        <p>
          Parfait uses AI to analyze transcripts and to generate and answer. To do this we send
          the relevant meeting and project content, such as transcript text, meeting details,
          existing commitments and tasks, and your questions, to OpenAI through its API. OpenAI
          processes that content to return a result, under its own terms and privacy policy.
        </p>
        <p>
          We do not use your meeting content to train our own models. AI output can be incomplete,
          inaccurate or misleading, so please review it before relying on it. Corrections you make
          are saved with your workspace.
        </p>
      </>
    )
  },
  {
    id: "sharing",
    title: "Service providers and who we share with",
    navLabel: "Service providers",
    body: (
      <>
        <p>
          We do not sell personal information. We share information with the following service
          providers only as needed to operate Parfait, and in the limited other cases below.
        </p>
        <ul>
          <li>
            <strong>Supabase</strong> provides authentication and the database where your account,
            meetings, transcripts, projects and generated outputs are stored.
          </li>
          <li>
            <strong>Recall.ai</strong> provides the meeting bot and transcription. It receives the
            meeting link, the bot name, an internal meeting identifier, and the meeting audio it
            needs to transcribe. It sends the transcript back to us. Recall.ai may retain data
            under its own policies.
          </li>
          <li>
            <strong>OpenAI</strong> provides AI analysis and generation, as described above.
          </li>
          <li>
            <strong>Vercel</strong> hosts the Service, runs its server functions and background
            jobs, and handles request logs.
          </li>
          <li>
            <strong>Resend</strong> delivers transactional email for us, specifically the
            authentication and account emails that Supabase sends on our behalf (such as email
            confirmation, password reset and one-time verification codes). It receives the
            recipient&apos;s email address, the content of that email (such as a confirmation or
            reset link or a code) and delivery information. It does not receive meeting
            transcripts, project content or AI-generated outputs.
          </li>
          <li>
            <strong>Google</strong> provides Google Sign In.
          </li>
        </ul>
        <p>
          We may also disclose information if required by law or legal process, to protect the
          rights, safety or security of users or the Service, or in connection with a merger,
          acquisition or sale of the business.
        </p>
      </>
    )
  },
  {
    id: "meeting-participants",
    title: "If you attend a meeting recorded with Parfait",
    navLabel: "Recorded meetings",
    body: (
      <p>
        Parfait is used by individuals and teams who add their own meetings. If you join a meeting
        where &ldquo;Parfait Notetaker&rdquo; is present, your speech may be transcribed and your
        name may appear in the transcript. The Parfait user who added the meeting decides to
        record it and is responsible for informing participants and obtaining any consents
        required. If you have questions or want your information removed from a transcript,
        please contact the meeting organizer or contact us using the details below.
      </p>
    )
  },
  {
    id: "cookies",
    title: "Cookies and similar technologies",
    navLabel: "Cookies",
    body: (
      <p>
        We use cookies that are necessary to run the Service: session cookies that keep you signed
        in, and a short-lived cookie that supports the password-reset process. We do not use
        cookies for advertising.
      </p>
    )
  },
  {
    id: "retention",
    title: "Data retention and deletion",
    navLabel: "Data retention",
    body: (
      <>
        <p>
          We keep your information while your account is active so the Service works for you. You
          can remove some data yourself:
        </p>
        <ul>
          <li>
            <strong>Meetings.</strong> Deleting a meeting removes it from your workspace. The
            record is marked as deleted in our database and is not currently purged automatically.
          </li>
          <li>
            <strong>Projects.</strong> Deleting a project permanently deletes the project and its
            project-level data, such as project memory and project conversations. Meetings and
            tasks that were assigned to the project remain, unassigned.
          </li>
          <li>
            <strong>Earlier Google connection.</strong> Earlier versions of Parfait offered an
            optional Google Meet connection, which is no longer available. We do not use any data
            from it. If you connected it in the past, tell us and we will delete any connection
            data we still hold.
          </li>
        </ul>
        <p>
          Parfait does not yet have a self-service option to delete your whole account. To request
          deletion of your account and associated data, including Google user data, contact us
          using the details below. We will delete or de-identify the data we hold about you within
          a reasonable time, except where we must keep it for legal reasons. Copies may remain in
          backups for a limited period.
        </p>
      </>
    )
  },
  {
    id: "choices",
    title: "Your choices",
    navLabel: "Your choices",
    body: (
      <>
        <ul>
          <li>Edit or correct profile details, meeting details and generated outputs in the app.</li>
          <li>Remove Parfait&apos;s access to your Google account at any time in your Google Account permissions.</li>
          <li>Choose not to add a meeting if participants have not agreed to be recorded.</li>
          <li>
            Ask us to access, correct or delete your information. We will respond as required by
            the law that applies to you.
          </li>
        </ul>
        <ContactDetails topic="privacy and data requests" />
      </>
    )
  },
  {
    id: "security",
    title: "Security",
    navLabel: "Security",
    body: (
      <p>
        We use reasonable safeguards: connections to the Service are encrypted in transit, database
        tables are protected with row-level security, server-side checks confirm that records
        belong to the signed-in user, and secrets such as API keys stay on the
        server. No system is perfectly secure, and we cannot guarantee absolute security. We do not
        claim any security certification.
      </p>
    )
  },
  {
    id: "children",
    title: "Children's privacy",
    navLabel: "Children's privacy",
    body: (
      <p>
        Parfait is not directed to children and is not intended for anyone under 18. We do not
        knowingly collect personal information from children. If you believe a child has provided
        us information, contact us and we will delete it.
      </p>
    )
  },
  {
    id: "changes",
    title: "Changes to this policy",
    navLabel: "Policy changes",
    body: (
      <p>
        We may update this policy as Parfait changes. We will post the new version here and update
        the effective date. If a change is material, we will take reasonable steps to notify you,
        such as by email or a notice in the app.
      </p>
    )
  },
  {
    id: "contact",
    title: "Contact",
    navLabel: "Contact",
    body: (
      <>
        <p>
          Questions about this policy, or requests about your data? Our{" "}
          <Link href="/terms" className={textLink}>
            Terms of Service
          </Link>{" "}
          explain the rules for using Parfait.
        </p>
        <ContactDetails topic="privacy questions and requests" />
      </>
    )
  }
];

export function PrivacyPolicy({ signedIn }: { signedIn: boolean }) {
  return (
    <LegalDocument
      title="Privacy Policy"
      signedIn={signedIn}
      sections={privacySections}
      lead={
        <p>
          This policy explains how Parfait{LEGAL_OPERATOR_NAME ? `, operated by ${LEGAL_OPERATOR_NAME},` : ""}{" "}
          (&ldquo;Parfait&rdquo;, &ldquo;we&rdquo;, &ldquo;us&rdquo;) collects, uses and shares
          information when you use our website and application at parfait-app.com (the
          &ldquo;Service&rdquo;). Parfait is an AI-powered meeting execution workspace that turns
          meetings into structured, actionable work.
        </p>
      }
    />
  );
}
