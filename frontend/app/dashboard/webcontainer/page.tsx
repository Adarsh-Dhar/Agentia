
// Use a separate Client Component to render WebContainerRunner
import WebcontainerClient from "./webcontainer-client";

export default function WebcontainerPage() {
	return (
		<div className="flex justify-center items-center min-h-screen bg-slate-950">
			<WebcontainerClient />
		</div>
	);
}
