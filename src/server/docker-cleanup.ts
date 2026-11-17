// Docker may report a conflict while AutoRemove or another removal is still
// releasing a container's mounts. A missing resource is already cleaned up.
export async function removeDockerResource(remove: () => Promise<unknown>) {
  for (let attempt = 0; ; attempt++) {
    try {
      await remove();
      return;
    } catch (error: any) {
      if (error.statusCode === 404) return;
      if (error.statusCode !== 409 || attempt >= 50) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}
