# 🛰️ 3D Vector Reconstruction & Landslide Simulator Concept

This document preserves the physics, mathematical solver, and architecture of the 3D Vector Reconstruction and Landslide Simulator designed for **GeotRadarSim**. This enables zero-loss recovery of this technology for future geotechnical slope monitoring projects.

---

## 1. Physical & Mathematical Foundations

### The 1D Line-of-Sight (LOS) Blindness
An interferometric ground-based radar (GB-InSAR or RAR) calculates displacement by measuring phase differences of the returned electromagnetic waves. Because phase represents distance along the travel path, **a single radar can only measure 1D displacement along its own line-of-sight (LOS) beam**.

Given a true 3D displacement vector $\vec{v} = [v_x, v_y, v_z]^T$ at a slope cell, and a radar situated at direction unit vector $\hat{u} = [u_x, u_y, u_z]^T$ relative to the cell, the apparent 1D measurement $m$ registered by the radar is the projection:
$$m = \vec{v} \cdot \hat{u} = v_x u_x + v_y u_y + v_z u_z$$

If the block of rock slides orthogonally to $\hat{u}$, then $m = 0$, representing a **complete vectorial blind zone**.

---

### The Moore-Penrose Pseudo-Inverse 3D Solver
By deploying $N \ge 2$ radars with distinct spatial positions, we obtain a system of linear equations to reconstruct the true 3D vector $\vec{v}$:
$$\begin{bmatrix} 
u_{1x} & u_{1y} & u_{1z} \\
u_{2x} & u_{2y} & u_{2z} \\
\vdots & \vdots & \vdots \\
u_{Nx} & u_{Ny} & u_{Nz}
\end{bmatrix}
\begin{bmatrix} v_x \\ v_y \\ v_z \end{bmatrix}
= \begin{bmatrix} m_1 \\ m_2 \\ \vdots \\ m_N \end{bmatrix}$$

Or compactly:
$$M \vec{v} = \vec{m}$$

Where $M$ is the $N \times 3$ **Geometry Matrix** of radar look vectors. 
Since $M$ is typically not square (for $N > 3$) or we want a least-squares solution, we solve using the **Moore-Penrose pseudo-inverse**:
$$\vec{v}_{reconstructed} = (M^T M)^{-1} M^T \vec{m}$$

Where:
* $M^T M$ is a $3 \times 3$ symmetric matrix representing the directional coverage tensor of our network.
* If $\det(M^T M) \approx 0$, the radars are co-linear (or we have only 1 radar), making the system singular. The determinant serves as a **Geometric Singularity Indicator**.
* The **Geometric Sensitivity Index** $S_v$ represents the noise amplification factor, calculated from the eigenvalues of $(M^T M)^{-1}$.

---

## 2. Web Worker Implementation (`vectorWorker.ts`)

The background solver runs inside a high-performance Web Worker using zero-copy flat buffers (`Float32Array`) for transferable performance. Below is the optimized implementation of the 3D solver:

```typescript
// vectorWorker.ts — Moore-Penrose Solver
self.onmessage = function (e) {
  const { action, payload } = e.data;
  if (action === "COMPUTE_SENSITIVITY") {
    const { rows, cols, radars, bounds, resolution, grid } = payload;
    const size = rows * cols;
    const flat_sensitivity = new Float32Array(size);

    for (let r = 0; r < rows; r++) {
      const rowOffset = r * cols;
      const cellY = bounds.min_y - r * resolution;
      for (let c = 0; c < cols; c++) {
        const cellX = bounds.min_x + c * resolution;
        const cellZ = grid[r]?.[c] ?? 0;

        if (isNaN(cellZ)) {
          flat_sensitivity[rowOffset + c] = -1.0;
          continue;
        }

        // 1. Pack unit look directions
        const u: [number, number, number][] = [];
        for (let i = 0; i < radars.length; i++) {
          const rx = radars[i].position.x;
          const ry = radars[i].position.y;
          const rz = radars[i].position.z;
          const dx = rx - cellX;
          const dy = ry - cellY;
          const dz = rz - cellZ;
          const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
          if (dist > 1e-3) {
            u.push([dx/dist, dy/dist, dz/dist]);
          }
        }

        if (u.length < 2) {
          flat_sensitivity[rowOffset + c] = 0.0;
          continue;
        }

        // 2. Build M^T * M (3x3 Matrix)
        let m00=0, m01=0, m02=0, m11=0, m12=0, m22=0;
        for (let i = 0; i < u.length; i++) {
          const ui = u[i];
          m00 += ui[0] * ui[0];
          m01 += ui[0] * ui[1];
          m02 += ui[0] * ui[2];
          m11 += ui[1] * ui[1];
          m12 += ui[1] * ui[2];
          m22 += ui[2] * ui[2];
        }

        // Determinant of 3x3 matrix
        const det = m00*(m11*m22 - m12*m12) - m01*(m01*m22 - m12*m02) + m02*(m01*m12 - m11*m02);

        if (Math.abs(det) < 1e-6) {
          flat_sensitivity[rowOffset + c] = 0.01; // Singular
        } else {
          // Average sensitivity is linked to reciprocal eigenvalues (trace of inverse matrix)
          const inv_trace = ((m11*m22 - m12*m12) + (m00*m22 - m02*m02) + (m00*m11 - m01*m01)) / det;
          const sens = Math.min(1.0, Math.max(0.001, 1.0 / (inv_trace + 1e-3)));
          flat_sensitivity[rowOffset + c] = sens;
        }
      }
    }

    // Transferable ownership transfer
    self.postMessage(
      { status: "SUCCESS", flat_sensitivity },
      [flat_sensitivity.buffer]
    );
  }
};
```

---

## 3. Simulator State Machine (`vectorStore.ts`)

A Zustand store coordinates the induced landslide state, noise simulation, and resolved arrows:

* **Induce landslide**: Computes the maximum slope fall vector (using neighborhood elevation gradients $[-\frac{\partial Z}{\partial X}, -\frac{\partial Z}{\partial Y}, -1]$ normalized) at the double-clicked cell.
* **Add noise**: Applies a random Gaussian perturbation (using the Box-Muller transform) to the LOS readings before solving:
  $$m_{noisy} = m_{apparent} + N(0, \sigma)$$
* **Solve**: Runs the Moore-Penrose pseudoinverse multiplier locally to resolve the simulated 3D vector and calculate error metrics (magnitude error and angular error in degrees).

---

This elegant physics engine remains safe and archived inside `.atl/vector_reconstruction_concept.md` for our next geotechnical project.
